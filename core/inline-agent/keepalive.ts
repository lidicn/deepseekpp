/**
 * Inline agent keepalive marker (T40).
 *
 * Thin wrapper over the shared chat-loop marker in `core/chat/active-loop.ts`.
 * The inline agent running inside the web page calls `beginAgentKeepalive`
 * when a loop starts and `endAgentKeepalive` when it reaches a terminal state,
 * so the service-worker-side reconcile logic can detect an interrupted loop.
 *
 * `markChatLoopStarted('web')` already acquires the SW keepalive alarm
 * (reference-counted) and `markChatLoopFinished` releases it; this module does
 * not re-register alarms.
 *
 * 接线点（真机，content.ts，本模块不直接改）：
 *   - `startInlineAgentIfNeeded` 成功启动后调 `await beginAgentKeepalive()`
 *   - loop 终态（完成 / 失败 / 取消）处调 `await endAgentKeepalive()`
 *
 * R16（全程 25s 心跳、工具间隙不断档）依赖 chrome.alarms，仅 SW 可用，
 * content script 侧需经 runtime 消息请求保活，属真机 MV3 行为，留待用户验证。
 */

import { markChatLoopFinished, markChatLoopStarted } from '../chat/active-loop';

/**
 * 标记一个 web inline agent loop 开始；同时由 active-loop  acquired SW 保活引用。
 */
export async function beginAgentKeepalive(): Promise<void> {
  await markChatLoopStarted('web');
}

/**
 * 标记 inline agent loop 结束；释放对应的 SW 保活引用。
 * 幂等：无活动 marker 时 active-loop 侧 remove 为空操作。
 */
export async function endAgentKeepalive(): Promise<void> {
  await markChatLoopFinished();
}
