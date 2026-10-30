/**
 * Refactor Telemetry — 常驻调试数据采集（v1.17 增强版）
 *
 * 用途：采集请求侧和结果侧的关键指标，通过 window.__DPP_DEBUG__ 导出。
 * 门控见 core/debug/telemetry-gate.ts：默认开启，侧栏设置项为权威来源，
 * localStorage.dpp_debug === '0' 作为页面手动兜底。
 * 只记录并持久化计数、比率与字节数；提示词原文与请求体样本一律不留存
 * （MAIN world 的内容对页面上任何脚本都可见，视为不可信通道）。
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

import { isTelemetryCaptureEnabled } from "./telemetry-gate";
import { countCatalogTools, formatPromptSegments, measurePromptSegments } from './prompt-segments';
import {
  buildLastTurnSummary,
  g2UserInterventionRate,
  type HarnessEvent,
  type LastTurnSummary,
} from "./harness-events";
import { diagnosticLogBuffer } from "../diagnostics/log-buffer";

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
  candidateToolFields: Record<string, number>;
  promptBytes: number;
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

/** M0 G1：按天滚动窗口（含今天共 N 天），用于“最近 7 天工具调用成功率”。 */
export const TOOL_CALL_WINDOW_DAYS = 7;
export interface ToolCallDayBucket {
  success: number;
  failure: number;
}

/** 本地时区日期键 YYYY-MM-DD（避免 UTC 跨日误差）。 */
function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 从持久化数据恢复按天桶，损坏/缺字段降级为 0（不抛错）。 */
function normalizeToolCallByDay(raw: unknown): Record<string, ToolCallDayBucket> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ToolCallDayBucket> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const bucket = value as Partial<ToolCallDayBucket>;
    out[key] = {
      success: Number(bucket.success) || 0,
      failure: Number(bucket.failure) || 0,
    };
  }
  return out;
}

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
  // M0 可选字段：缺失视为 0（向后兼容旧聚合，AGENTS.md:41）。
  modelRequestedCount?: number;
  userContinuedCount?: number;
  loopDepthHistogram?: Record<number, number>;
  toolCallByDay?: Record<string, ToolCallDayBucket>;
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
  private suspiciousTruncationCount = 0;
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
  // M0：G2 续跑分组计数 + turn 最终深度直方图（持久化聚合，ring buffer 不进此）。
  private modelRequestedCount = 0;
  private userContinuedCount = 0;
  private loopDepthHistogram: Record<number, number> = {};
  // M0 G1：最近 7 天工具调用成败分桶（本地日期键）。
  private toolCallByDay: Record<string, ToolCallDayBucket> = {};

  // R10：仅内存保留「最近一个 turnId」的旁路事件，供 lastTurn() 聚合；不持久化、不进 G1/G2。
  private recentTurnEvents: HarnessEvent[] = [];
  private recentTurnId: string | null = null;
  private static readonly RECENT_TURN_EVENT_LIMIT = 200;

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
        modelRequestedCount: this.modelRequestedCount,
        userContinuedCount: this.userContinuedCount,
        loopDepthHistogram: { ...this.loopDepthHistogram },
        toolCallByDay: JSON.parse(JSON.stringify(this.toolCallByDay)),
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
      this.modelRequestedCount = data.modelRequestedCount || 0;
      this.userContinuedCount = data.userContinuedCount || 0;
      this.loopDepthHistogram = data.loopDepthHistogram || {};
      this.toolCallByDay = normalizeToolCallByDay(data.toolCallByDay);
    } catch {
      // 数据损坏，忽略
    }
  }

  recordRequest(metrics: RequestMetrics, promptText = ""): void {
    if (!isTelemetryCaptureEnabled()) return;
    if (this.requests.length >= MAX_RECORDS) this.requests.shift();
    if (this.lastPromptText !== null && metrics.promptBytes > 0) {
      const lcpBytes = longestCommonPrefixBytes(this.lastPromptText, promptText);
      const totalBytes = Math.max(this.lastPromptText.length, metrics.promptBytes) > 0
        ? Math.max(
            new TextEncoder().encode(this.lastPromptText).length,
            metrics.promptBytes,
          )
        : 1;
      this.prefixConsistencyRates.push(lcpBytes / totalBytes);
    }
    // 提示词原文只作为本次 LCP 计算的入参，比较完即丢：既不进记录，也不进 dump()。
    this.lastPromptText = promptText || null;
    this.requests.push(metrics);
    console.log(
      `[DPP-DEBUG] request: route=${metrics.route} ` +
      `payload=${metrics.payloadBytes}B tools=${metrics.toolsBytes}B ` +
      `(${metrics.toolsCount} tools, order=[${metrics.toolsOrder.join(",")}])`,
    );
  }

  recordTruncation(metrics: TruncationMetrics): void {
    if (!isTelemetryCaptureEnabled()) return;
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

  recordSuspiciousTruncation(): void {
    if (!isTelemetryCaptureEnabled()) return;
    this.suspiciousTruncationCount++;
  }

  // v1.17 新增：工具调用结果记录
  recordToolCall(success: boolean, errorType?: string): void {
    if (!isTelemetryCaptureEnabled()) return;
    if (success) {
      this.toolCallSuccess++;
    } else {
      this.toolCallFailure++;
      if (errorType) {
        this.toolCallErrors[errorType] = (this.toolCallErrors[errorType] || 0) + 1;
      }
    }
    // M0 G1：更新今天的按天桶，并裁剪到最近 TOOL_CALL_WINDOW_DAYS 天。
    const today = localDayKey();
    const bucket = this.toolCallByDay[today] ?? { success: 0, failure: 0 };
    if (success) bucket.success++;
    else bucket.failure++;
    this.toolCallByDay[today] = bucket;
    this.pruneToolCallByDay(Date.now());
    this.saveToStorage();
  }

  /** 删除窗口外的旧日期桶，保持存储有界。 */
  private pruneToolCallByDay(now: number): void {
    const allowed = new Set<string>();
    for (let i = 0; i < TOOL_CALL_WINDOW_DAYS; i++) {
      allowed.add(localDayKey(new Date(now - i * 24 * 60 * 60 * 1000)));
    }
    for (const key of Object.keys(this.toolCallByDay)) {
      if (!allowed.has(key)) delete this.toolCallByDay[key];
    }
  }

  // v1.17 新增：转义修复结果记录
  recordEscapeRepair(success: boolean): void {
    if (!isTelemetryCaptureEnabled()) return;
    if (success) {
      this.escapeRepairSuccess++;
    } else {
      this.escapeRepairFailure++;
    }
    this.saveToStorage();
  }

  // v1.17 新增：工具目录缓存命中记录
  recordToolSchemaCache(hit: boolean): void {
    if (!isTelemetryCaptureEnabled()) return;
    if (hit) {
      this.toolSchemaCacheHits++;
    } else {
      this.toolSchemaCacheMisses++;
    }
    this.saveToStorage();
  }

  /**
   * M0：消费 harness 事件的持久化聚合部分。
   * - continuation_triggered：按 reason 累加 G2 分子/分母（单一事件分组，无双计数）。
   * - turn_finished：把最终深度记入直方图。
   * - tool_call_start / tool_call_end / loop_depth_incremented：
   *   G1 由独立 recordToolCall 承担（避免重复计数），瞬时深度由 ring buffer（harness-events.ts）保留，
   *   本方法不重复持久化。
   * 失败显式、有界、已测试地降级，观测永不成为主链路失败源（AGENTS.md:57）。
   */
  recordHarnessEvent(event: HarnessEvent): void {
    if (!isTelemetryCaptureEnabled()) return;
    try {
      // R10: 旁路保留最近一个 turnId 的事件（仅内存，不影响 G1/G2 聚合与持久化）。
      if (this.recentTurnId !== event.turnId) {
        this.recentTurnId = event.turnId;
        this.recentTurnEvents = [];
      }
      this.recentTurnEvents.push(event);
      if (this.recentTurnEvents.length > RefactorTelemetry.RECENT_TURN_EVENT_LIMIT) {
        this.recentTurnEvents.shift();
      }

      if (event.type === "continuation_triggered") {
        if (event.reason === "user_continued") {
          this.userContinuedCount++;
        } else {
          this.modelRequestedCount++;
        }
        this.saveToStorage();
      } else if (event.type === "turn_finished") {
        const depth = event.finalDepth;
        this.loopDepthHistogram[depth] = (this.loopDepthHistogram[depth] || 0) + 1;
        this.saveToStorage();
      }
    } catch (error) {
      console.warn("[DPP-DEBUG] recordHarnessEvent degraded:", error);
    }
  }

  /**
   * R10：返回「刚刚这一轮」的聚合快照（turnId/steps/tools/sseFrameCount/
   * stopReason/finished/durationMs/errors）。W29 trace 未落地前，sseFrameCount、
   * stopReason、无配对的 durationMs 为 null，由 buildLastTurnSummary 诚实留空。
   */
  lastTurn(): LastTurnSummary {
    return buildLastTurnSummary(this.recentTurnEvents);
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
    this.modelRequestedCount = 0;
    this.userContinuedCount = 0;
    this.loopDepthHistogram = {};
    this.toolCallByDay = {};
    this.recentTurnEvents = [];
    this.recentTurnId = null;
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

    // M0 G2：用户干预率 = userContinued / (userContinued + modelRequested)，样本为 0 时“样本不足”。
    const g2 = g2UserInterventionRate({
      modelRequestedCount: this.modelRequestedCount,
      userContinuedCount: this.userContinuedCount,
    });
    const g2UserInterventionRateText =
      g2 === null ? "样本不足" : `${Math.round(g2 * 1000) / 10}%`;

    // M0 G1：最近 7 天滚动窗口成功率（桶已 prune 到窗口内，直接汇总）。
    let windowSuccess = 0;
    let windowFailure = 0;
    for (const key of Object.keys(this.toolCallByDay)) {
      windowSuccess += this.toolCallByDay[key].success;
      windowFailure += this.toolCallByDay[key].failure;
    }
    const windowTotal = windowSuccess + windowFailure;
    const toolCallSuccessRate7d = windowTotal > 0
      ? `${Math.round((windowSuccess / windowTotal) * 1000) / 10}%`
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
      suspiciousTruncationCount: this.suspiciousTruncationCount,
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
      // M0 G1 近 7 天窗口 + G2 续跑分组 + 深度直方图
      toolCallSuccessRate7d,
      toolCallWindowDays: TOOL_CALL_WINDOW_DAYS,
      toolCallByDay: JSON.parse(JSON.stringify(this.toolCallByDay)),
      modelRequestedCount: this.modelRequestedCount,
      userContinuedCount: this.userContinuedCount,
      g2UserInterventionRate: g2UserInterventionRateText,
      loopDepthHistogram: { ...this.loopDepthHistogram },
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

    const promptText = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const promptBytes = promptText ? new TextEncoder().encode(promptText).length : 0;
    const toolMatches = promptText.match(/### Tool /g);
    const toolCountInPrompt = toolMatches ? toolMatches.length : 0;
    const promptSegments = measurePromptSegments(promptText);
    const catalogTools = countCatalogTools(promptText);
    const catalogStart = promptText.indexOf('### Available Tools');
    const toolCatalogBytes = catalogStart >= 0
      ? new TextEncoder().encode(promptText.substring(catalogStart)).length
      : 0;

    // 提示词原文只在这里参与计算，recordRequest 不保存它，请求体样本同样不落记录。
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
      candidateToolFields,
      promptBytes,
      toolCountInPrompt,
      toolCatalogBytes,
    }, promptText);

    if (promptText) {
      console.log(
        `[DPP-DEBUG] prompt: ${promptBytes}B = ${formatPromptSegments(promptSegments)}, ` +
        `tools in prompt: ${toolCountInPrompt}, ` +
        `catalog tools: full ${catalogTools.full} / indexOnly ${catalogTools.indexOnly}, catalog section: ${toolCatalogBytes}B${catalogStart < 0 ? ' (no Available Tools marker)' : ''}`,
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
 * 门控由 core/debug/telemetry-gate.ts 提供：默认挂载，页面手动 dpp_debug='0' 可关。
 */
export function mountDebugToWindow(): void {
  if (typeof window === "undefined") return;
  if (!isTelemetryCaptureEnabled()) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__DPP_DEBUG__) return;
  w.__DPP_DEBUG__ = {
    dump: () => refactorTelemetry.dump(),
    reset: () => refactorTelemetry.reset(),
    summary: () => refactorTelemetry.summary(),
    lastTurn: () => refactorTelemetry.lastTurn(),
    logs: () => diagnosticLogBuffer.snapshot(),
    full: () => ({ ...refactorTelemetry.dump(), logs: diagnosticLogBuffer.snapshot() }),
    clearLogs: () => diagnosticLogBuffer.clear(),
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
