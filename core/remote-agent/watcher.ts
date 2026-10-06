/**
 * Remote Agent Watcher
 *
 * Polls DeepSeek's history API for new messages from remote devices (e.g.
 * the mobile app). When a new user message is detected that has no
 * corresponding assistant reply, it automatically "re-sends" the message
 * from the current browser tab so that deepseek++'s fetch interceptor
 * can augment it with tool catalog and trigger the inline agent loop.
 *
 * This enables a "mobile input → desktop execution" workflow:
 *   1. User sends a message from the DeepSeek mobile app
 *   2. Desktop browser polls the history API and detects the new message
 *   3. Desktop automatically re-sends the message (intercepted + augmented)
 *   4. Deep++ runs tools and replies
 *   5. Result syncs back to the mobile app
 */

import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n';
import { DEEPSEEK_WEB_ROUTES } from '../deepseek/contracts';
import { createClientHeaders } from '../deepseek/active-client';

const POLL_INTERVAL_MS = 5000; // 5 seconds
const MAX_BACKOFF_MS = 60_000; // 60 seconds ceiling
const MAX_RETRIES = 3;
/** How long to wait for the platform to store our re-sent copy before checking. */
const RESEND_RECEIPT_WAIT_MS = 5000;
/** Minimum interval between two resend attempts for the same message (prevents spam). */
const RESEND_RETRY_COOLDOWN_MS = 8000;

interface HistoryMessage {
  message_id: number;
  role: 'USER' | 'ASSISTANT';
  content?: string;
  create_time?: number;
  fragments?: Array<{
    id: number;
    type: string;
    content: string;
  }>;
}

interface HistoryResponse {
  messages: HistoryMessage[];
}

/** The remote message we have injected but not yet seen come back. */
interface PendingResend {
  messageId: number;
  attempts: number;
  lastAttemptAt: number;
}

interface WatcherState {
  enabled: boolean;
  pollTimer: number | null;
  lastSeenMessageId: number | null;
  chatSessionId: string | null;
  isProcessing: boolean;
  isInitializing: boolean;  // 等待 fetchInitialState 完成
  lastSentMessageContent: string | null;
  lastSentMessageTime: number;
  consecutivePollFailures: number;  // 连续轮询失败计数（用于退避 + 错误分级）
  currentPollIntervalMs: number;    // 当前轮询间隔（退避后可能 > POLL_INTERVAL_MS）
  pendingResend: PendingResend | null;
  notifyResendFailed: ((content: string) => void) | null;
}

const state: WatcherState = {
  enabled: false,
  pollTimer: null,
  lastSeenMessageId: null,
  chatSessionId: null,
  isProcessing: false,
  isInitializing: false,
  lastSentMessageContent: null,
  lastSentMessageTime: 0,
  consecutivePollFailures: 0,
  currentPollIntervalMs: POLL_INTERVAL_MS,
  pendingResend: null,
  notifyResendFailed: null,
};

/**
 * 每次 start/stop 递增。异步的 initial fetch 回调只有在 token 未变时
 * 才允许启动轮询链，否则 stop→start 之后会出现两条并行的 poll 链。
 */
let startToken = 0;

/**
 * 记录当前浏览器发送的消息（用于自适应检测，避免重复重发）
 */
export function recordLocalSentMessage(content: string): void {
  state.lastSentMessageContent = content;
  state.lastSentMessageTime = Date.now();
  console.log(`[DPP-REMOTE] Recorded local sent message: ${content.slice(0, 50)}...`);
}

/** A history row's text body: DeepSeek stores it in fragments, content is the fallback. */
function messageText(message: HistoryMessage): string {
  return message.fragments?.[0]?.content || message.content || '';
}

/**
 * Extract chat_session_id from URL.
 * URL format: https://chat.deepseek.com/a/chat/s/{chat_session_id}
 */
function extractChatSessionIdFromURL(): string | null {
  const match = window.location.pathname.match(/\/chat\/s\/([a-f0-9-]+)/);
  return match ? match[1] : null;
}

/**
 * Start watching for remote messages.
 */
export function startRemoteAgentWatcher(options: {
  chatSessionId: string;
  /** Called once when a remote message is dropped after MAX_RETRIES attempts. */
  onResendFailed?: (content: string) => void;
}): void {
  if (state.enabled) {
    console.warn('[DPP-REMOTE] Watcher already running');
    return;
  }

  state.enabled = true;
  state.chatSessionId = options.chatSessionId;
  state.isProcessing = false;
  state.isInitializing = true;
  state.consecutivePollFailures = 0;
  state.currentPollIntervalMs = POLL_INTERVAL_MS;
  state.pendingResend = null;
  state.notifyResendFailed = options.onResendFailed ?? null;
  const token = ++startToken;

  // Initialize lastSeenMessageId from current history (skip existing messages)
  // B3 fix: race — 用 isInitializing 锁阻止 initial fetch 完成前的 poll
  fetchInitialState(options.chatSessionId).then((lastId) => {
    if (token !== startToken || !state.enabled) return;
    state.lastSeenMessageId = lastId;
    state.isInitializing = false;
    console.log(`[DPP-REMOTE] Watcher started, last seen message: ${lastId}`);
    // 启动递归 setTimeout 轮询（替代固定 setInterval，支持退避）
    scheduleNextPoll();
  }).catch((err) => {
    if (token !== startToken || !state.enabled) return;
    console.error('[DPP-REMOTE] Initial fetch failed, retrying via poll:', err);
    // 不能永久停在 paused：lastSeenMessageId 仍为 null 时 poll 会把当前历史
    // 整体当作"已看过"（findNewMessages 返回 []），所以直接交给退避重试链。
    state.isInitializing = false;
    state.consecutivePollFailures = 1;
    state.currentPollIntervalMs = POLL_INTERVAL_MS;
    scheduleNextPoll();
  });

  console.log('[DPP-REMOTE] Watcher start scheduled');
}

/**
 * 递归 setTimeout 调度器 — 每次 poll 完根据退避状态计算下次间隔
 */
function scheduleNextPoll(): void {
  if (!state.enabled) return;
  const interval = state.currentPollIntervalMs;
  state.pollTimer = window.setTimeout(async () => {
    if (!state.enabled) return;
    try {
      await pollForNewMessages();
      // poll 成功 — 重置失败计数 + 恢复正常间隔
      if (state.consecutivePollFailures > 0) {
        console.log(`[DPP-REMOTE] Poll recovered after ${state.consecutivePollFailures} failures`);
      }
      state.consecutivePollFailures = 0;
      state.currentPollIntervalMs = POLL_INTERVAL_MS;
    } catch (err) {
      // poll 失败 — 累加计数 + 指数退避
      state.consecutivePollFailures++;
      const prevInterval = state.currentPollIntervalMs;
      state.currentPollIntervalMs = Math.min(
        POLL_INTERVAL_MS * Math.pow(2, Math.min(state.consecutivePollFailures - 1, 4)),
        MAX_BACKOFF_MS,
      );
      // 日志分级：1-2 次 warn，≥3 次 error（避免每 5s 刷红错）
      const logLevel = state.consecutivePollFailures >= 3 ? 'error' : 'warn';
      console[logLevel](
        `[DPP-REMOTE] Poll failed (${state.consecutivePollFailures} consecutive), backoff ${prevInterval}ms → ${state.currentPollIntervalMs}ms:`,
        err,
      );
    } finally {
      scheduleNextPoll();
    }
  }, interval);
}

/**
 * Stop the watcher.
 */
export function stopRemoteAgentWatcher(): void {
  state.enabled = false;
  startToken++;
  state.pendingResend = null;
  state.notifyResendFailed = null;
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  console.log('[DPP-REMOTE] Watcher stopped');
}

/**
 * Check if the watcher is enabled.
 */
export function isRemoteAgentWatcherEnabled(): boolean {
  return state.enabled;
}

async function fetchInitialState(chatSessionId: string): Promise<number | null> {
  try {
    const messages = await fetchHistoryMessages(chatSessionId);
    if (messages.length === 0) return null;
    // Return the ID of the last message
    return messages[messages.length - 1].message_id;
  } catch (err) {
    console.error('[DPP-REMOTE] Failed to fetch initial state:', err);
    return null;
  }
}

async function pollForNewMessages(): Promise<void> {
  if (state.isProcessing) return;
  // B3 fix: 首启 race — initial fetch 未完成前跳过 poll
  if (state.isInitializing) return;

  // 每次从 URL 重新读取 chat_session_id（支持切换对话）
  const currentChatSessionId = extractChatSessionIdFromURL();
  if (!currentChatSessionId) return;

  try {
    const messages = await fetchHistoryMessages(currentChatSessionId);

    console.log('[DPP-REMOTE] Last seen:', state.lastSeenMessageId);
    console.log('[DPP-REMOTE] Current messages:', messages.map(m => ({ id: m.message_id, role: m.role, content: m.content?.slice(0, 30) })));

    // Find new messages (after lastSeenMessageId)
    const newMessages = findNewMessages(messages, state.lastSeenMessageId);

    if (newMessages.length === 0) {
      console.log('[DPP-REMOTE] No new messages');
      return;
    }

    console.log(`[DPP-REMOTE] Found ${newMessages.length} new message(s)`);

    // 找最新的 USER 消息
    const latestUserMessage = newMessages.findLast(m => m.role === 'USER');
    
    if (latestUserMessage) {
      // 从 fragments[0].content 取消息内容
      const contentStr = messageText(latestUserMessage);
      
      // v1.17 安全修复：跳过 inline-agent continuation 请求。
      // DeepSeek 把续跑的 `<original_task>` + `<tool_results>` 块存成 USER role，
      // watcher 如果把它当"远程新消息"re-send 就会触发无限循环。
      // 结构检测：两个标签同时存在，且含续跑关键字
      const isInlineAgentContinuation =
        contentStr.includes('<original_task>') && contentStr.includes('</original_task>') &&
        (contentStr.includes('<tool_results') || contentStr.includes('<tool_results_so_far>'));
      
      // 跳过纯系统提示被误存为 USER 的情况（AI 回复被当成 USER message）
      // 特征：开头是 "你具有长期记忆能力" 或包含完整 system prompt + ## Tools
      const isSystemPromptEcho =
        contentStr.startsWith('你具有长期记忆能力') ||
        (contentStr.includes('## Tools') && contentStr.includes('你具有长期记忆能力') && contentStr.length > 10000);
      
      if (isInlineAgentContinuation || isSystemPromptEcho) {
        console.log(`[DPP-REMOTE] Skip internal message (continuation=${isInlineAgentContinuation}, echo=${isSystemPromptEcho}): ${contentStr.slice(0, 80)}...`);
        state.lastSeenMessageId = latestUserMessage.message_id;
        return;
      }
      
      // 自适应检测：如果这条消息是当前浏览器刚刚发送的（30秒内），就跳过。
      // 两侧都 trim：content.ts 记录的是 textarea 的 trim() 值，history 里的
      // content 常带首尾换行，严格相等会漏判 → 本机消息被当成远程消息重发。
      // 但正在等回执的那条不能走这个短路：重发前我们刚刚登记过同样的文本，
      // 否则一次失败的注入会被判成"本机发的"，消息从此静默丢失。
      const isRetryOfPendingResend =
        state.pendingResend?.messageId === latestUserMessage.message_id;
      const isLocalMessage = !isRetryOfPendingResend &&
                             state.lastSentMessageContent !== null &&
                             state.lastSentMessageContent.trim() === contentStr.trim() &&
                             (Date.now() - state.lastSentMessageTime) < 30000;
      if (isLocalMessage) {
        console.log(`[DPP-REMOTE] Skip local message (sent from this browser): ${contentStr.slice(0, 50)}...`);
        state.lastSeenMessageId = latestUserMessage.message_id;
        return;
      }
      
      state.isProcessing = true;
      console.log(`[DPP-REMOTE] Detected remote message: ${contentStr.slice(0, 100)}...`);

      try {
        if (!beginResendAttempt(latestUserMessage.message_id)) {
          // beginResendAttempt returns false for two distinct reasons:
          //   1. cooldown active (pendingResend still set, attempts <= MAX) → skip this poll cycle only
          //   2. max retries exhausted (pendingResend cleared) → drop the message visibly
          const pending = state.pendingResend;
          if (pending?.messageId === latestUserMessage.message_id) {
            console.log(
              `[DPP-REMOTE] Resend cooldown active for message ${latestUserMessage.message_id} ` +
                `(attempt ${pending.attempts}/${MAX_RETRIES}), skipping this poll cycle`,
            );
            return;
          }
          // 三次都没回执：这条消息只能放弃，但放弃必须是用户看得见的，
          // 不能只留一行插件日志（"手机端发了、电脑端没收到"）。
          console.error(
            `[DPP-REMOTE] Dropping message ${latestUserMessage.message_id} after ${MAX_RETRIES} attempts`,
          );
          state.lastSeenMessageId = latestUserMessage.message_id;
          state.notifyResendFailed?.(contentStr);
          return;
        }
        const attempts = state.pendingResend?.attempts ?? 1;

        // 直接在页面里重发消息（不刷新，inline agent loop 状态保留）
        console.log('[DPP-REMOTE] Re-sending message via UI...');
        // 先登记"这条是我们自己发的"：重发后它会在 history 里以新的 USER
        // 消息出现，去重不能只依赖注入的合成 Enter 被 content.ts 监听到。
        recordLocalSentMessage(contentStr);

        let cursorAfterReceipt: number | null = null;
        try {
          await resendMessageViaUI(contentStr);
          cursorAfterReceipt = await readResendReceipt(
            contentStr,
            latestUserMessage.message_id,
            currentChatSessionId,
          );
        } catch (err) {
          console.warn(`[DPP-REMOTE] Resend attempt ${attempts}/${MAX_RETRIES} failed:`, err);
        }

        if (cursorAfterReceipt !== null) {
          state.pendingResend = null;
          state.lastSeenMessageId = cursorAfterReceipt;
          console.log(`[DPP-REMOTE] Receipt confirmed, last seen -> ${cursorAfterReceipt}`);
        } else {
          // 游标原地不动：下一轮还会看到这条，重试直到上限。
          console.warn(
            `[DPP-REMOTE] No receipt for message ${latestUserMessage.message_id} ` +
              `(attempt ${attempts}/${MAX_RETRIES}), keeping last seen at ${state.lastSeenMessageId}`,
          );
        }
      } finally {
        // B4 fix: try-finally 替代裸 8s setTimeout
        state.isProcessing = false;
      }
    } else {
      // No user message, just update last seen
      state.lastSeenMessageId = messages[messages.length - 1]?.message_id ?? state.lastSeenMessageId;
    }
  } catch (err) {
    // 只 debug 日志，真正的错误分级 + 退避由 scheduleNextPoll 统一处理
    console.debug('[DPP-REMOTE] Poll inner failure (rethrown for backoff):', err);
    throw err;  // re-throw，让外层 scheduleNextPoll 处理退避
  }
}

/**
 * Count one resend attempt for `messageId`. Returns false once the cap is
 * reached (and clears the pending entry) so the caller can drop the message
 * instead of looping on it for the rest of the session.
 */
function beginResendAttempt(messageId: number): boolean {
  const pending = state.pendingResend?.messageId === messageId ? state.pendingResend : null;
  // Cooldown: don't re-send the same message too rapidly. The poll loop runs
  // every 5s and the receipt wait is 5s, so without a cooldown a failed
  // injection gets retried on the very next poll → visible duplicate sends.
  if (pending && Date.now() - pending.lastAttemptAt < RESEND_RETRY_COOLDOWN_MS) {
    return false;
  }
  const attempts = (pending?.attempts ?? 0) + 1;
  if (attempts > MAX_RETRIES) {
    state.pendingResend = null;
    return false;
  }
  state.pendingResend = { messageId, attempts, lastAttemptAt: Date.now() };
  return true;
}

/**
 * Wait for the platform to store the copy we just injected, then return the
 * id the cursor may move to — or null when there is no evidence the message
 * actually left this browser.
 *
 * The receipt has to be a *newer* USER row with the same text: the remote
 * original is already in history, so matching on content alone would confirm
 * a send that never happened.
 */
async function readResendReceipt(
  content: string,
  detectedMessageId: number,
  sentInChatSessionId: string,
): Promise<number | null> {
  await new Promise((resolve) => setTimeout(resolve, RESEND_RECEIPT_WAIT_MS));

  const currentChatSessionId = extractChatSessionIdFromURL();
  if (!currentChatSessionId) return null;
  if (currentChatSessionId !== sentInChatSessionId) {
    console.warn(
      '[DPP-REMOTE] Chat switched while awaiting the resend receipt; cursor left untouched',
    );
    return null;
  }

  const freshMessages = await fetchHistoryMessages(currentChatSessionId);
  const expected = content.trim();
  const received = freshMessages.some(
    (message) =>
      message.role === 'USER' &&
      message.message_id > detectedMessageId &&
      messageText(message).trim() === expected,
  );
  if (!received) return null;
  return freshMessages[freshMessages.length - 1]?.message_id ?? null;
}

async function fetchHistoryMessages(chatSessionId: string): Promise<HistoryMessage[]> {
  const url = `${DEEPSEEK_WEB_ROUTES.history}?chat_session_id=${encodeURIComponent(chatSessionId)}&limit=20&_t=${Date.now()}`;
  console.log('[DPP-REMOTE] Fetching history:', url);

  const clientHeaders = createClientHeaders();
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      ...clientHeaders,
    },
  });

  console.log('[DPP-REMOTE] Response status:', response.status);

  if (!response.ok) {
    const text = await response.text();
    console.error('[DPP-REMOTE] Response error:', text.slice(0, 500));
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  console.log('[DPP-REMOTE] Response keys:', Object.keys(data));
  

  // Actual format: { code: 0, data: { biz_data: { chat_messages: [...] } } }
  
  
  
  
  const messages = data?.data?.biz_data?.chat_messages ?? [];
  
  console.log('[DPP-REMOTE] Messages count:', messages?.length);

  return messages;
}

function findNewMessages(messages: HistoryMessage[], lastSeenId: number | null): HistoryMessage[] {
  if (lastSeenId === null) {
    // B3 fix: 首次运行 — 把当前所有消息当作"已看过"（不回放历史）
    // 调用方应在 initial fetch 后再启动 poll，见 pollForNewMessages 的 isInitializing 锁
    return [];
  }
  const idx = messages.findIndex((m) => m.message_id === lastSeenId);
  if (idx === -1) {
    // B3 fix: 会话切换 — 旧 lastSeenId 不在新 history 里，
    // 把新会话最后一条当作"已看过"，不回放整个新会话历史
    if (messages.length > 0) {
      const newLast = messages[messages.length - 1].message_id;
      if (newLast !== lastSeenId) {
        console.warn(`[DPP-REMOTE] Session switch detected: lastSeen=${lastSeenId} not in new history, resetting to ${newLast}`);
      }
      return [];
    }
    return [];
  }
  return messages.slice(idx + 1);
}

function findPendingUserMessage(messages: HistoryMessage[]): HistoryMessage | null {
  // Find the last user message that has no corresponding assistant reply
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'USER') {
      // Check if there's an assistant reply after this user message
      const hasReply = messages.slice(i + 1).some((m) => m.role === 'ASSISTANT');
      if (!hasReply) {
        return msg;
      }
      // There's a reply, so this user message is already handled
      return null;
    }
  }
  return null;
}

/**
 * Composer selectors, most specific first. The bare `textarea` is a
 * last-resort fallback, so it must never be the *first* thing a caller looks
 * at — see `recordLocalSendFromActiveInput`.
 */
const CHAT_INPUT_SELECTORS = [
  'textarea#chat-input',
  'textarea[placeholder*="发消息"]',
  'textarea[placeholder*="chat"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="输入"]',
  'div[contenteditable="true"]',
  'textarea',
];

/** The DeepSeek composer, or null when this page shape is unknown. */
export function findChatInputElement(): HTMLElement | null {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      console.log(`[DPP-REMOTE] Found input box with selector: ${selector}`);
      return el;
    }
  }
  return null;
}

/** A composer's current text: `value` for a textarea, the body for contenteditable. */
function readComposerText(input: HTMLElement): string {
  return input instanceof HTMLTextAreaElement ? input.value : input.textContent || '';
}

/**
 * Remember what this browser is about to send from the composer, so the
 * watcher does not read the echo back out of history and re-send it.
 *
 * The text has to come from the composer itself: the page can hold unrelated
 * textareas (a sidebar draft, a rename box), and recording one of those would
 * suppress the *real* remote message that happens to match it.
 */
export function recordLocalSendFromActiveInput(): void {
  const input = findChatInputElement();
  if (!input) return;
  const content = readComposerText(input).trim();
  if (content) recordLocalSentMessage(content);
}

/**
 * Re-send a message by injecting it into the DeepSeek input box and clicking send.
 * This ensures the request goes through the normal UI flow (and thus through
 * our fetch interceptor).
 */
export async function resendMessageViaUI(message: string): Promise<void> {
  const found = findChatInputElement();

  if (!found) {
    throw new Error('Chat input not found');
  }
  const input = found;

  const isNativeInput = input instanceof HTMLTextAreaElement;

  // Focus and set value (use native setter so React recognizes it)
  input.focus();
  if (isNativeInput) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(input, message);
    } else {
      input.value = message;
    }
  } else {
    input.textContent = message;
  }

  // Trigger input event so React updates its state
  if (typeof InputEvent === 'function') {
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      inputType: isNativeInput ? 'insertFromPaste' : 'insertText',
      data: message,
    });
    input.dispatchEvent(inputEvent);
  } else {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Wait a bit for React to update
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Try clicking the send button first (more reliable than synthetic Enter on
  // React-controlled composers that ignore isTrusted=false KeyboardEvents).
  const sendButton = findSendButton(input);
  if (sendButton && !sendButton.hasAttribute('disabled')) {
    sendButton.click();
    console.log('[DPP-REMOTE] Message re-sent via UI (send button click)');
    return;
  }

  // Fallback: simulate pressing Enter
  const enterEvent = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(enterEvent);

  console.log('[DPP-REMOTE] Message re-sent via UI (Enter key fallback)');
}

/**
 * Locate the DeepSeek composer's send button relative to the input element.
 * DeepSeek renders it as a button inside the composer container; we search
 * the input's ancestors to avoid matching unrelated buttons on the page.
 */
function findSendButton(input: HTMLElement): HTMLButtonElement | null {
  let container: HTMLElement | null = input;
  for (let i = 0; i < 6 && container; i++) {
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    for (const btn of buttons) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const title = btn.getAttribute('title') || '';
      const text = btn.textContent?.trim() || '';
      if (
        ariaLabel.includes('发送') || ariaLabel.toLowerCase().includes('send') ||
        title.includes('发送') || title.toLowerCase().includes('send') ||
        text === '发送' || text.toLowerCase() === 'send'
      ) {
        return btn;
      }
    }
    container = container.parentElement;
  }
  return null;
}
