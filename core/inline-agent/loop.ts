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
  return runPiInlineAgentLoop({ payload, post, executeTool, signal, uploadImage });
}
