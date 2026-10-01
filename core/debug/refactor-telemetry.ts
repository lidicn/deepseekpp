/**
 * Refactor Telemetry — 常驻调试数据采集（v1.17 增强版）
 *
 * 用途：采集请求侧和结果侧的关键指标，通过 window.__DPP_DEBUG__ 导出。
 * 默认开启，仅 localStorage.dpp_debug === '0' 时关闭挂载。
 * 数据持久化到 localStorage，刷新不丢。
 *
 * 接入点：
 *   1. request-interceptor.ts — 最终请求体确定后，统计 tools 字段
 *   2. client-descriptor.ts   — MCP 工具结果截断前后
 *   3. result-governance.ts   — 通用工具结果截断前后
 *   4. repair-tool-json.ts    — 转义修复成功/失败
 *   5. prompt/augmentation.ts — 工具目录缓存命中率
 *
 * 使用方式（页面控制台）：
 *   __DPP_DEBUG__.summary() // 返回精简摘要
 *   __DPP_DEBUG__.export()  // 复制报告到剪贴板
 *   __DPP_DEBUG__.reset()   // 清空数据（含 localStorage）
 */

export interface RequestMetrics {
  timestamp: number;
  route: string;
  payloadBytes: number;
  toolsBytes: number;
  toolsCount: number;
  toolsOrder: string[];
  toolsByProvider: Record<string, number>;
  messageCount: number;
  augmentationApplied: boolean;
  bodySample: string;
  candidateToolFields: Record<string, number>;
  promptBytes: number;
  promptText: string;
  toolCountInPrompt: number;
  toolCatalogBytes: number;
}

export interface TruncationMetrics {
  timestamp: number;
  layer: "mcp" | "governance" | "runner" | "restore" | "storage";
  toolName: string;
  originalBytes: number;
  truncatedBytes: number;
  limit: number;
  truncated: boolean;
  markerPresent: boolean;
}

export interface DebugDump {
  requests: RequestMetrics[];
  truncations: TruncationMetrics[];
  startedAt: number;
}

const MAX_RECORDS = 200;
const STORAGE_KEY = 'dpp_telemetry_aggregates';

interface PersistedAggregates {
  startedAt: number;
  toolCallSuccess: number;
  toolCallFailure: number;
  toolCallErrors: Record<string, number>;
  escapeRepairSuccess: number;
  escapeRepairFailure: number;
  toolSchemaCacheHits: number;
  toolSchemaCacheMisses: number;
  prefixConsistencyRates: number[];
}

/**
 * 计算两个字符串的最长公共前缀（LCP）的 UTF-8 字节数。
 */
function longestCommonPrefixBytes(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return new TextEncoder().encode(a.substring(0, i)).length;
}

class RefactorTelemetry {
  private requests: RequestMetrics[] = [];
  private truncations: TruncationMetrics[] = [];
  private startedAt = Date.now();
  private lastPromptText: string | null = null;
  private prefixConsistencyRates: number[] = [];
  // v1.17 新增：工具调用统计
  private toolCallSuccess = 0;
  private toolCallFailure = 0;
  private toolCallErrors: Record<string, number> = {};
  // v1.17 新增：转义修复统计
  private escapeRepairSuccess = 0;
  private escapeRepairFailure = 0;
  // v1.17 新增：缓存命中率
  private toolSchemaCacheHits = 0;
  private toolSchemaCacheMisses = 0;

  constructor() {
    this.loadFromStorage();
  }

  private saveToStorage(): void {
    try {
      const data: PersistedAggregates = {
        startedAt: this.startedAt,
        toolCallSuccess: this.toolCallSuccess,
        toolCallFailure: this.toolCallFailure,
        toolCallErrors: this.toolCallErrors,
        escapeRepairSuccess: this.escapeRepairSuccess,
        escapeRepairFailure: this.escapeRepairFailure,
        toolSchemaCacheHits: this.toolSchemaCacheHits,
        toolSchemaCacheMisses: this.toolSchemaCacheMisses,
        prefixConsistencyRates: this.prefixConsistencyRates.slice(-100),
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 存储满或隐私模式，忽略
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as PersistedAggregates;
      this.startedAt = data.startedAt || Date.now();
      this.toolCallSuccess = data.toolCallSuccess || 0;
      this.toolCallFailure = data.toolCallFailure || 0;
      this.toolCallErrors = data.toolCallErrors || {};
      this.escapeRepairSuccess = data.escapeRepairSuccess || 0;
      this.escapeRepairFailure = data.escapeRepairFailure || 0;
      this.toolSchemaCacheHits = data.toolSchemaCacheHits || 0;
      this.toolSchemaCacheMisses = data.toolSchemaCacheMisses || 0;
      this.prefixConsistencyRates = data.prefixConsistencyRates || [];
    } catch {
      // 数据损坏，忽略
    }
  }

  recordRequest(metrics: RequestMetrics): void {
    if (this.requests.length >= MAX_RECORDS) this.requests.shift();
    if (this.lastPromptText !== null && metrics.promptBytes > 0) {
      const lcpBytes = longestCommonPrefixBytes(this.lastPromptText, metrics.promptText);
      const totalBytes = Math.max(this.lastPromptText.length, metrics.promptBytes) > 0
        ? Math.max(
            new TextEncoder().encode(this.lastPromptText).length,
            metrics.promptBytes,
          )
        : 1;
      this.prefixConsistencyRates.push(lcpBytes / totalBytes);
    }
    this.lastPromptText = metrics.promptText || null;
    this.requests.push(metrics);
    console.log(
      `[DPP-DEBUG] request: route=${metrics.route} ` +
      `payload=${metrics.payloadBytes}B tools=${metrics.toolsBytes}B ` +
      `(${metrics.toolsCount} tools, order=[${metrics.toolsOrder.join(",")}])`,
    );
  }

  recordTruncation(metrics: TruncationMetrics): void {
    if (this.truncations.length >= MAX_RECORDS) this.truncations.shift();
    this.truncations.push(metrics);
    if (metrics.truncated) {
      console.log(
        `[DPP-DEBUG] truncate: layer=${metrics.layer} tool=${metrics.toolName} ` +
        `${metrics.originalBytes}B → ${metrics.truncatedBytes}B ` +
        `(limit=${metrics.limit}B, marker=${metrics.markerPresent})`,
      );
    }
  }

  // v1.17 新增：工具调用结果记录
  recordToolCall(success: boolean, errorType?: string): void {
    if (success) {
      this.toolCallSuccess++;
    } else {
      this.toolCallFailure++;
      if (errorType) {
        this.toolCallErrors[errorType] = (this.toolCallErrors[errorType] || 0) + 1;
      }
    }
    this.saveToStorage();
  }

  // v1.17 新增：转义修复结果记录
  recordEscapeRepair(success: boolean): void {
    if (success) {
      this.escapeRepairSuccess++;
    } else {
      this.escapeRepairFailure++;
    }
    this.saveToStorage();
  }

  // v1.17 新增：工具目录缓存命中记录
  recordToolSchemaCache(hit: boolean): void {
    if (hit) {
      this.toolSchemaCacheHits++;
    } else {
      this.toolSchemaCacheMisses++;
    }
    this.saveToStorage();
  }

  dump(): DebugDump {
    return {
      requests: [...this.requests],
      truncations: [...this.truncations],
      startedAt: this.startedAt,
    };
  }

  reset(): void {
    this.requests = [];
    this.truncations = [];
    this.startedAt = Date.now();
    this.lastPromptText = null;
    this.prefixConsistencyRates = [];
    this.toolCallSuccess = 0;
    this.toolCallFailure = 0;
    this.toolCallErrors = {};
    this.escapeRepairSuccess = 0;
    this.escapeRepairFailure = 0;
    this.toolSchemaCacheHits = 0;
    this.toolSchemaCacheMisses = 0;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    console.log("[DPP-DEBUG] telemetry reset");
  }

  summary(): Record<string, unknown> {
    const reqCount = this.requests.length;
    const truncCount = this.truncations.filter((t) => t.truncated).length;
    const avgToolsBytes = reqCount
      ? Math.round(this.requests.reduce((s, r) => s + r.toolsBytes, 0) / reqCount)
      : 0;
    const avgPayloadBytes = reqCount
      ? Math.round(this.requests.reduce((s, r) => s + r.payloadBytes, 0) / reqCount)
      : 0;
    const totalSaved = this.truncations
      .filter((t) => t.truncated)
      .reduce((s, t) => s + (t.originalBytes - t.truncatedBytes), 0);

    const orderSets = new Set(this.requests.map((r) => r.toolsOrder.join("|")));
    const orderConsistency = reqCount > 1 ? (orderSets.size === 1 ? "100%一致" : `${orderSets.size}种顺序`) : "样本不足";

    const avgPromptBytes = reqCount
      ? Math.round(this.requests.reduce((s, r) => s + (r.promptBytes || 0), 0) / reqCount)
      : 0;
    const avgToolCatalogBytes = reqCount
      ? Math.round(this.requests.reduce((s, r) => s + (r.toolCatalogBytes || 0), 0) / reqCount)
      : 0;
    const avgToolCountInPrompt = reqCount
      ? Math.round(this.requests.reduce((s, r) => s + (r.toolCountInPrompt || 0), 0) / reqCount)
      : 0;

    const avgPrefixRate = this.prefixConsistencyRates.length > 0
      ? Math.round((this.prefixConsistencyRates.reduce((s, r) => s + r, 0) / this.prefixConsistencyRates.length) * 1000) / 10
      : null;

    // v1.17 新增指标计算
    const totalToolCalls = this.toolCallSuccess + this.toolCallFailure;
    const toolCallSuccessRate = totalToolCalls > 0
      ? `${Math.round((this.toolCallSuccess / totalToolCalls) * 1000) / 10}%`
      : "样本不足";
    const totalEscapeRepairs = this.escapeRepairSuccess + this.escapeRepairFailure;
    const escapeRepairRate = totalEscapeRepairs > 0
      ? `${Math.round((this.escapeRepairSuccess / totalEscapeRepairs) * 1000) / 10}%`
      : "样本不足";
    const totalCacheLookups = this.toolSchemaCacheHits + this.toolSchemaCacheMisses;
    const cacheHitRate = totalCacheLookups > 0
      ? `${Math.round((this.toolSchemaCacheHits / totalCacheLookups) * 1000) / 10}%`
      : "样本不足";

    // v1.18: per-layer truncation breakdown.
    // Model-visible truncations = mcp + governance only.
    // storage truncations do NOT affect what the model sees.
    const truncationsByLayer: Record<string, number> = {};
    let modelVisibleTruncations = 0;
    let storageTruncations = 0;
    for (const t of this.truncations) {
      if (!t.truncated) continue;
      truncationsByLayer[t.layer] = (truncationsByLayer[t.layer] || 0) + 1;
      if (t.layer === 'mcp' || t.layer === 'governance') modelVisibleTruncations++;
      if (t.layer === 'storage') storageTruncations++;
    }

    return {
      totalRequests: reqCount,
      totalTruncations: truncCount,
      modelVisibleTruncations,
      storageTruncations,
      truncationsByLayer,
      avgToolsBytes,
      avgPayloadBytes,
      avgPromptBytes,
      avgToolCatalogBytes,
      avgToolCountInPrompt,
      totalBytesSavedByTruncation: totalSaved,
      toolOrderConsistency: orderConsistency,
      uniqueToolOrders: orderSets.size,
      prefixConsistencyRate: avgPrefixRate !== null ? `${avgPrefixRate}%` : "样本不足",
      prefixConsistencySamples: this.prefixConsistencyRates.length,
      routes: [...new Set(this.requests.map((r) => r.route))],
      // v1.17 新增
      toolCallSuccess: this.toolCallSuccess,
      toolCallFailure: this.toolCallFailure,
      toolCallSuccessRate,
      toolCallErrors: this.toolCallErrors,
      escapeRepairSuccess: this.escapeRepairSuccess,
      escapeRepairFailure: this.escapeRepairFailure,
      escapeRepairRate,
      toolSchemaCacheHits: this.toolSchemaCacheHits,
      toolSchemaCacheMisses: this.toolSchemaCacheMisses,
      toolSchemaCacheHitRate: cacheHitRate,
    };
  }
}

// 单例
export const refactorTelemetry = new RefactorTelemetry();

/**
 * 从最终请求体 JSON 中提取 tools 指标。
 */
export function recordRequestFromBody(
  body: string,
  route: string,
  augmentationApplied: boolean,
): void {
  try {
    const payloadBytes = new TextEncoder().encode(body).length;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const messages = Array.isArray(parsed.messages) ? parsed.messages.length : 0;

    const CANDIDATE_TOOL_FIELDS = [
      'tools', 'functions', 'tool_descriptors', 'available_tools',
      'tool_schemas', 'toolDefinitions', 'tool_definitions',
      'descriptors', 'functionDeclarations', 'function_declarations',
    ];
    const candidateToolFields: Record<string, number> = {};
    let tools: Array<Record<string, unknown>> = [];
    let toolsFieldName = '';
    for (const field of CANDIDATE_TOOL_FIELDS) {
      const val = parsed[field];
      if (Array.isArray(val) && val.length > 0) {
        candidateToolFields[field] = val.length;
        if (tools.length === 0) {
          tools = val as Array<Record<string, unknown>>;
          toolsFieldName = field;
        }
      }
    }

    if (tools.length === 0) {
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const field of CANDIDATE_TOOL_FIELDS) {
            const nested = (val as Record<string, unknown>)[field];
            if (Array.isArray(nested) && nested.length > 0) {
              candidateToolFields[`${key}.${field}`] = nested.length;
              if (tools.length === 0) {
                tools = nested as Array<Record<string, unknown>>;
                toolsFieldName = `${key}.${field}`;
              }
            }
          }
        }
      }
    }

    const toolsBytes = tools.length > 0
      ? new TextEncoder().encode(JSON.stringify(tools)).length
      : 0;

    const toolsOrder = tools.map((t) => {
      const fn = t.function as Record<string, unknown> | undefined;
      return String(t.name ?? fn?.name ?? t.type ?? "unknown");
    });
    const toolsByProvider: Record<string, number> = {};
    for (const tool of tools) {
      const prov = tool.provider as Record<string, unknown> | undefined;
      const provider = String(prov?.kind ?? tool.provider ?? tool.type ?? "unknown");
      toolsByProvider[provider] = (toolsByProvider[provider] ?? 0) + 1;
    }

    const bodySample = body.length > 2000 ? body.substring(0, 2000) + '...[truncated sample]' : body;

    const promptText = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const promptBytes = promptText ? new TextEncoder().encode(promptText).length : 0;
    const toolMatches = promptText.match(/### Tool /g);
    const toolCountInPrompt = toolMatches ? toolMatches.length : 0;
    const catalogStart = promptText.indexOf('### Available Tools');
    const toolCatalogBytes = catalogStart >= 0
      ? new TextEncoder().encode(promptText.substring(catalogStart)).length
      : 0;

    refactorTelemetry.recordRequest({
      timestamp: Date.now(),
      route,
      payloadBytes,
      toolsBytes,
      toolsCount: tools.length,
      toolsOrder,
      toolsByProvider,
      messageCount: messages,
      augmentationApplied,
      bodySample,
      candidateToolFields,
      promptBytes,
      promptText,
      toolCountInPrompt,
      toolCatalogBytes,
    });

    if (promptText) {
      console.log(
        `[DPP-DEBUG] prompt: ${promptBytes}B, tools in prompt: ${toolCountInPrompt}, ` +
        `catalog section: ${toolCatalogBytes}B${catalogStart < 0 ? ' (no Available Tools marker)' : ''}`,
      );
    }

    if (toolsFieldName) {
      console.log(`[DPP-DEBUG] tools found in field: ${toolsFieldName} (${tools.length} tools, ${toolsBytes}B)`);
    } else {
      console.log(`[DPP-DEBUG] no tools field found. Top-level keys: ${Object.keys(parsed).join(', ')}`);
    }
  } catch (error) {
    console.warn("[DPP-DEBUG] failed to parse request body for telemetry", error);
  }
}

/**
 * 挂载到 window，供页面控制台访问。
 * v1.17：默认开启，dpp_debug='0' 可关闭。
 */
export function mountDebugToWindow(): void {
  if (typeof window === "undefined") return;
  const debugEnabled = (() => {
    try {
      return window.localStorage.getItem("dpp_debug") !== "0";
    } catch {
      return true;
    }
  })();
  if (!debugEnabled) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__DPP_DEBUG__) return;
  w.__DPP_DEBUG__ = {
    dump: () => refactorTelemetry.dump(),
    reset: () => refactorTelemetry.reset(),
    summary: () => refactorTelemetry.summary(),
    export: async () => {
      const report = JSON.stringify(refactorTelemetry.summary(), null, 2);
      try {
        await navigator.clipboard.writeText(report);
        console.log("%c[DPP-DEBUG] report copied to clipboard!", "color: #4CAF50; font-weight: bold");
      } catch {
        console.log("[DPP-DEBUG] report:", report);
      }
      return report;
    },
    version: "refactor-telemetry-v2",
  };
  console.log(
    "%c[DPP-DEBUG] telemetry mounted. Use __DPP_DEBUG__.summary() / .export() / .reset()",
    "color: #2196F3; font-weight: bold",
  );
}
