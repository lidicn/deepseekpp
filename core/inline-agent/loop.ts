/**
 * Inline agent loop entry (Issue A3-T2).
 *
 * The self-built loop engine was replaced by the pi-agent-core engine
 * (`core/inline-agent/pi/loop-adapter.ts`). This module is now a thin
 * composition root: it preserves the released public contract
 * (`runInlineAgentLoop(payload, deps)` with the same AGENT_* event protocol,
 * execution-policy, authorization and abort semantics) while delegating the
 * engine to the pi loop driven by the DS-web StreamFn and tool bridge.
 */
import { runPiInlineAgentLoop } from './pi/loop-adapter';
import type { PostFn, ExecuteToolFn, PiLoopAdapterDeps } from './pi/loop-adapter';
import type { InlineAgentStartPayload } from './types';
import { diagnosticLogBuffer } from '../diagnostics/log-buffer';

export type { PostFn, ExecuteToolFn };

export interface InlineAgentLoopDeps {
  post: PostFn;
  executeTool: ExecuteToolFn;
  signal: AbortSignal;
  /** M-URL 修复：上传图片到 DeepSeek 服务器，返回 file_id */
  uploadImage?: PiLoopAdapterDeps['uploadImage'];
}

export async function runInlineAgentLoop(
  payload: InlineAgentStartPayload,
  deps: InlineAgentLoopDeps,
): Promise<void> {
  const { post, executeTool, signal, uploadImage } = deps;
  // 观测探针（2026-10-21）：真机验证时出现「工具确实执行了，但没有产生任何 trace」。
  // 必须先区分两种完全不同的原因：
  //   (a) 这一轮根本没有进入 inline agent 循环（埋点位置放错了链路）；
  //   (b) 进入了循环，但轨迹持久化失败（写入丢失）。
  // 这条诊断出现＝(b)，不出现＝(a)。零风险：只写一条摘要日志，不含正文。
  try {
    diagnosticLogBuffer.record({
      level: 'info',
      source: 'inline-agent',
      message: 'agent_loop_entered',
      details: `loopId=${payload.loopId} step=${payload.toolExecutions?.length ?? 0}`,
    });
  } catch {
    // 观测不得影响主流程。
  }
  return runPiInlineAgentLoop({ payload, post, executeTool, signal, uploadImage });
}
