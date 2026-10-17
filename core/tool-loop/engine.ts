import type { ToolCall, ToolExecutionRecord, ToolResult } from '../types';

export type ToolLoopExecuteTool = (call: ToolCall) => Promise<ToolExecutionRecord>;

export interface ExecuteToolCallsOptions {
  signal?: AbortSignal;
}

export async function executeToolCallsSequentially(
  calls: readonly ToolCall[],
  executeTool: ToolLoopExecuteTool,
  options?: ExecuteToolCallsOptions,
): Promise<ToolExecutionRecord[]> {
  const results: ToolExecutionRecord[] = [];
  for (const call of calls) {
    if (options?.signal?.aborted) break;
    results.push(await executeTool(call));
  }
  return results;
}

// D-03: 续跑循环的退出原因。旧版所有 break 都静默返回 {turn, executions}，
// 调用方无法区分"模型正常答完 / 流被切断 / 达到上限"，导致该提示用户的没提示、
// 该自动续跑的没续跑。现在显式返回 termination。
export type ToolContinuationTermination =
  | 'completed'     // 模型这轮没再输出工具调用 = 正常结束
  | 'stream_cut'    // 上一轮没有可续接的 parentMessageId = 流被切断
  | 'max_depth';    // 达到 maxDepth 上限（abort 由 assertContinuationActive 抛异常处理，不在此列）

export interface ToolContinuationLoopInput<TTurn> {
  initialTurn: TTurn;
  maxDepth: number;
  getAssistantText: (turn: TTurn) => string;
  getParentMessageId: (turn: TTurn) => number | null;
  extractToolCalls: (assistantText: string) => ToolCall[];
  executeToolCall: (
    call: ToolCall,
    parentMessageId: number,
    position: { depth: number; callIndex: number },
  ) => Promise<ToolExecutionRecord>;
  buildContinuationPrompt: (executions: ToolExecutionRecord[]) => string;
  submitContinuation: (prompt: string, parentMessageId: number) => Promise<TTurn>;
  signal?: AbortSignal;
  assertActive?: () => void;
}

export async function runToolContinuationLoop<TTurn>(
  input: ToolContinuationLoopInput<TTurn>,
): Promise<{ turn: TTurn; executions: ToolExecutionRecord[]; termination: ToolContinuationTermination }> {
  let turn = input.initialTurn;
  let parentMessageId = input.getParentMessageId(turn);
  const executions: ToolExecutionRecord[] = [];
  // 未被 break 命中时，循环必然是因为 depth 跑满 maxDepth 退出。
  let termination: ToolContinuationTermination | undefined;

  for (let depth = 0; depth < input.maxDepth; depth++) {
    assertContinuationActive(input);
    if (parentMessageId === null) {
      termination = 'stream_cut';
      break;
    }

    const calls = input.extractToolCalls(input.getAssistantText(turn));
    if (calls.length === 0) {
      termination = 'completed';
      break;
    }

    const stepExecutions: ToolExecutionRecord[] = [];
    for (let callIndex = 0; callIndex < calls.length; callIndex++) {
      assertContinuationActive(input);
      const execution = await input.executeToolCall(
        calls[callIndex],
        parentMessageId,
        { depth, callIndex },
      );
      assertContinuationActive(input);
      stepExecutions.push(execution);
      executions.push(execution);
    }

    assertContinuationActive(input);
    turn = await input.submitContinuation(
      input.buildContinuationPrompt(stepExecutions),
      parentMessageId,
    );
    assertContinuationActive(input);
    parentMessageId = input.getParentMessageId(turn);
  }

  // termination 仍为 undefined 说明循环是因 depth 跑满而退出（非 break）。
  return { turn, executions, termination: termination ?? 'max_depth' };
}

function assertContinuationActive<TTurn>(input: ToolContinuationLoopInput<TTurn>): void {
  input.assertActive?.();
  if (!input.signal?.aborted) return;
  const reason = input.signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('Automation continuation was aborted.', 'AbortError');
}

export function createToolExecutionRecord(
  call: ToolCall,
  result: ToolResult,
  limits: { detailMaxLength: number; outputMaxLength: number },
): ToolExecutionRecord {
  return {
    name: result.name ?? call.name,
    provider: result.provider ?? call.provider,
    descriptorId: result.descriptorId ?? call.descriptorId,
    result: {
      ok: result.ok,
      name: result.name,
      provider: result.provider,
      descriptorId: result.descriptorId,
      summary: result.summary,
      detail: clampText(result.detail, limits.detailMaxLength),
      output: result.output === undefined
        ? undefined
        : clampText(JSON.stringify(result.output), limits.outputMaxLength),
      truncated: result.truncated,
      error: result.error,
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function clampText(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value;
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = '\n...[truncated]';
  const markerBytes = encoder.encode(marker).byteLength;
  const limit = Math.max(0, maxBytes - markerBytes);
  let boundary = Math.min(limit, bytes.byteLength);
  while (boundary > 0 && (bytes[boundary] & 0xC0) === 0x80) boundary--;
  return `${decoder.decode(bytes.subarray(0, boundary))}${marker}`;
}
