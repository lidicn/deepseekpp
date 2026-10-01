import type {
  ToolCall,
  ToolResult,
} from '../tool/types';
import type {
  McpCallToolOptions,
  McpCallToolResult,
  McpProtocolTransport,
  McpServerConfig,
} from './types';
import {
  McpProtocolError,
  createMcpRequest,
  unwrapMcpResponse,
  normalizeMcpToolResult,
  getMcpToolName,
} from './client-descriptor';

// ===== local_file_read auto 续读：确定性代码循环，不依赖模型自觉续读 =====
// 直接复用本模块的 transport 请求/响应解析原语，避免递归与跨模块循环依赖。
// 聚合结果最终仍交回 normalizeMcpToolResult，与通用 MCP 路径共用同一套字节上限、
// 计时与 output 归一化逻辑，不另起第二条返回路径。
//
// 单窗传输切片上限（12000 字符 × 4 字节 ≈ 48KB < 64KB 响应体上限）。这是传输层实现细节，
// 不改变调用方看到的 max_chars 语义。
const AUTO_READ_WINDOW_CHARS = 12000;
// 与宿主 contracts.mjs 已发布契约保持一致：max_chars 为「本次最多返回字符数」总量语义，
// 缺省 16000，硬上限 MAX_LOCAL_FILE_READ_CHARS（100_000）。
const AUTO_READ_DEFAULT_TOTAL_CHARS = 16000;
const AUTO_READ_MAX_TOTAL_CHARS = 100_000;
const AUTO_READ_MAX_WINDOWS = 1000;

export async function callLocalFileReadAuto(
  server: McpServerConfig,
  transport: McpProtocolTransport,
  options: McpCallToolOptions,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const call = options.call;
  const payload = call.payload as Record<string, unknown>;
  const path = String(payload?.path ?? '');
  // max_chars 保持已发布契约的「本次最多返回字符数」总量语义：它是本次调用返回内容的总预算，
  // 由多个窗口分摊消耗；AUTO_READ_WINDOW_CHARS 仅是传输切片，绝不上浮为调用方上限。
  const requestedMaxChars = payload?.max_chars;
  const totalBudget = typeof requestedMaxChars === 'number'
    && Number.isFinite(requestedMaxChars) && requestedMaxChars >= 1
    ? Math.min(Math.floor(requestedMaxChars), AUTO_READ_MAX_TOTAL_CHARS)
    : AUTO_READ_DEFAULT_TOTAL_CHARS;
  // L4：兼容模型显式传入的起始偏移（与宿主 createLocalFileReadResult 的 start 语义一致）；
  // 未传或非法时从 0 开始完整读取。
  const requestedStart = payload?.start;
  const start0 = typeof requestedStart === 'number' && Number.isFinite(requestedStart) && requestedStart >= 0
    ? Math.floor(requestedStart)
    : 0;

  const contents: string[] = [];
  let totalChars = 0;
  let start = start0;
  let prevNextStart = start0;
  let lastTruncated = false;
  let remainingBudget = totalBudget;
  let budgetExhausted = false;

  for (let guard = 0; guard < AUTO_READ_MAX_WINDOWS; guard++) {
    // 每窗只申请「剩余总预算」与「单窗传输上限」中的较小值，使总返回量严格不超过 max_chars。
    const windowChars = Math.min(AUTO_READ_WINDOW_CHARS, remainingBudget);
    if (windowChars <= 0) {
      budgetExhausted = true;
      break;
    }
    let windowResult: McpCallToolResult;
    try {
      const response = await transport.request<Record<string, unknown>, McpCallToolResult>(
        createMcpRequest('tools/call', {
          name: getMcpToolName(call, options.descriptor),
          arguments: { ...payload, path, start, max_chars: windowChars },
        }),
        {
          timeoutMs: options.timeoutMs ?? server.timeouts.requestMs,
          maxResponseBytes: options.maxResultBytes ?? server.limits.maxResultBytes,
          signal: options.signal,
        },
      );
      windowResult = unwrapMcpResponse(response, 'mcp_tool_call_failed') as McpCallToolResult;
    } catch (err) {
      return buildAutoReadResult(server, options, startedAt, contents, totalChars, false, `第 ${contents.length + 1} 窗调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (windowResult.structuredContent as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;
    const content = typeof data?.content === 'string' ? data.content : undefined;
    if (typeof content !== 'string') {
      return buildAutoReadResult(server, options, startedAt, contents, totalChars, false, '无法从工具结果解析窗口内容');
    }
    contents.push(content);
    // 按 Unicode 码点计数扣减预算，与宿主 charsRead 同义（代理对不会被重复计为两个字符）。
    remainingBudget -= Array.from(content).length;
    if (typeof data?.totalChars === 'number') totalChars = data.totalChars;
    const truncated = data?.truncated === true;
    lastTruncated = truncated;
    if (!truncated) break;
    if (remainingBudget <= 0) {
      budgetExhausted = true;
      break;
    }
    const nextStart = typeof data?.nextStart === 'number' ? data.nextStart : NaN;
    if (!Number.isFinite(nextStart) || nextStart <= prevNextStart) {
      return buildAutoReadResult(server, options, startedAt, contents, totalChars, false, `nextStart 未前进 (${prevNextStart} -> ${nextStart})`);
    }
    prevNextStart = nextStart;
    start = nextStart;
  }
  // 预算耗尽是调用方通过 max_chars 主动设定的上限，属正常成功返回，只需如实标记 truncated。
  if (budgetExhausted) {
    return buildAutoReadResult(server, options, startedAt, contents, totalChars, true, undefined, true);
  }
  // M1 修复：若因达到最大窗口数而退出循环，且最后一窗仍 truncated（文件超过上限），
  // 必须 fail-closed（ok:false 且 truncated:true），不得谎报为成功读取（fail-open）。
  if (lastTruncated) {
    return buildAutoReadResult(
      server,
      options,
      startedAt,
      contents,
      totalChars,
      false,
      `auto 续读窗口数已达上限（${AUTO_READ_MAX_WINDOWS}），文件可能过大未完整读取`,
      true,
    );
  }
  return buildAutoReadResult(server, options, startedAt, contents, totalChars, true, undefined);
}

function buildAutoReadResult(
  server: McpServerConfig,
  options: McpCallToolOptions,
  startedAt: number,
  contents: string[],
  totalChars: number,
  ok: boolean,
  failReason?: string,
  truncated = false,
): ToolResult {
  const call = options.call;
  const windows = contents.length;
  // 输出形状与非 auto 路径同构：单一 data.content 字符串，而非逐窗数组。
  const content = contents.join('');
  const charsReturned = Array.from(content).length;
  const detail = ok
    ? `已通过 auto 续读分 ${windows} 窗读取，返回 ${charsReturned} 字符（文件共 ${totalChars} 字符）${truncated ? '，已达 max_chars 上限，内容未完整' : '，无静默截断'}。完整内容见 output.data.content。`
    : `local_file_read auto 续读异常终止（${failReason ?? '未知原因'}）。已读取 ${windows} 窗，共 ${charsReturned} 字符。`;
  // 将聚合结果装配为标准 McpCallToolResult 后交回 normalizeMcpToolResult：
  // 由其统一施加 maxResultBytes 字节上限、计时与 output 归一化，避免另起一条绕过统一
  // normalization 的返回路径（这正是评审指出的 max_chars/maxResultBytes 失效根因）。
  const aggregated: McpCallToolResult = {
    content: [{ type: 'text', text: detail }],
    structuredContent: {
      data: {
        path: String((call.payload as Record<string, unknown>)?.path ?? ''),
        windows,
        totalChars,
        charsReturned,
        truncated,
        content,
      },
    },
    isError: !ok,
  };
  const normalized = normalizeMcpToolResult(server, call, aggregated, startedAt, options.maxResultBytes);
  return {
    ...normalized,
    summary: ok ? 'local_file_read auto 续读完成' : 'local_file_read auto 续读失败',
    truncated: normalized.truncated || truncated,
    error: ok
      ? undefined
      : {
        code: 'local_file_read_auto_failed',
        message: failReason ?? 'auto 续读失败',
        retryable: false,
        details: { externalOutcome: 'confirmed', retrySafe: false },
      },
  };
}

