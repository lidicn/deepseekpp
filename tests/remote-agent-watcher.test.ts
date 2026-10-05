/**
 * Remote Agent watcher guardrails.
 *
 * The watcher polls DeepSeek's history API and re-injects a message it thinks
 * came from another device. These tests pin the properties that keep that from
 * turning into a silently lost message:
 *   - one poll chain runs, so each interval issues exactly one history request
 *   - a message this browser sent itself is never re-sent, even when the
 *     history copy differs in surrounding whitespace
 *   - the last-seen cursor only moves once the re-sent copy is *visible* in
 *     history (DPP-04: an Enter that never landed must not look like progress)
 *   - a mid-receipt session switch leaves the cursor where it was
 *   - retries are capped, and the cap ends in a user-visible notice, not in
 *     the plugin log
 *
 * The history fixture models what DeepSeek actually does: when the desktop tab
 * re-sends, the message comes back as a *new* USER row with a larger
 * message_id. A test that never appends that row is asserting the no-receipt
 * path, not the happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../core/deepseek/active-client', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

import {
  isRemoteAgentWatcherEnabled,
  recordLocalSentMessage,
  startRemoteAgentWatcher,
  stopRemoteAgentWatcher,
} from '../core/remote-agent/watcher';

const CHAT_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_SESSION_ID = 'ffffffff-1111-2222-3333-444444444444';
const POLL_INTERVAL_MS = 5_000;
/** resendMessageViaUI waits 200ms for React between typing and Enter. */
const UI_SETTLE_MS = 250;
/** The watcher's post-resend receipt wait. */
const RECEIPT_WAIT_MS = 3_050;
const MAX_RETRIES = 3;

interface HistoryMessage {
  message_id: number;
  role: 'USER' | 'ASSISTANT';
  content?: string;
  fragments?: Array<{ id: number; type: string; content: string }>;
}

function userMessage(id: number, content: string): HistoryMessage {
  return { message_id: id, role: 'USER', fragments: [{ id, type: 'content', content }] };
}

function historyResponse(messages: HistoryMessage[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { biz_data: { chat_messages: messages } } }),
    text: async () => '',
  } as unknown as Response;
}

const sent: string[] = [];
const notices: string[] = [];
const histories = new Map<string, HistoryMessage[]>();

function inputStub(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.id = 'chat-input';
  return el;
}

/**
 * resendMessageViaUI writes through the native prototype setter (so React
 * notices), so the spy has to sit on the prototype, not on the element.
 * `onSend` decides whether the platform echoes the send back into history —
 * leaving it out is how a test simulates "Enter never landed".
 */
let onSend: ((value: string) => void) | null = null;

function spyOnTextAreaValue(): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set').mockImplementation(
    function setValue(this: HTMLTextAreaElement, value: string) {
      sent.push(value);
      onSend?.(value);
      nativeSetter?.call(this, value);
    },
  );
}

/** Serve each session's own history, the way the real endpoint does. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchHistory = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://chat.deepseek.com');
    const sessionId = url.searchParams.get('chat_session_id') ?? '';
    return historyResponse(histories.get(sessionId) ?? []);
  });
  vi.stubGlobal('fetch', fetchHistory);
  return fetchHistory;
}

function appendEcho(sessionId: string, nextId: number): (value: string) => void {
  return (value: string) => {
    histories.get(sessionId)?.push(userMessage(nextId, value));
  };
}

async function drain(times = 24): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Advance one poll interval and let the awaited fetch chain settle. */
async function tick(): Promise<void> {
  await drain();
  vi.advanceTimersByTime(POLL_INTERVAL_MS);
  await drain();
}

/** Run the send's own settle timer plus the watcher's receipt wait. */
async function receiptWindow(): Promise<void> {
  await drain();
  vi.advanceTimersByTime(UI_SETTLE_MS);
  await drain();
  vi.advanceTimersByTime(RECEIPT_WAIT_MS);
  await drain();
}

/** One full detect → resend → receipt-check cycle. */
async function attempt(): Promise<void> {
  await tick();
  await receiptWindow();
}

function startWatcher(): void {
  startRemoteAgentWatcher({
    chatSessionId: CHAT_SESSION_ID,
    onResendFailed: (content) => notices.push(content),
  });
}

/** Start, let the initial fetch seed the cursor, then let the first poll run. */
async function startAndSettle(): Promise<void> {
  startWatcher();
  await drain();
  vi.advanceTimersByTime(POLL_INTERVAL_MS);
  await drain();
  expect(isRemoteAgentWatcherEnabled()).toBe(true);
}

beforeEach(() => {
  sent.length = 0;
  notices.length = 0;
  histories.clear();
  onSend = null;
  vi.useFakeTimers();
  spyOnTextAreaValue();
  document.body.innerHTML = '';
  document.body.appendChild(inputStub());
  window.history.pushState({}, '', `/a/chat/s/${CHAT_SESSION_ID}`);
});

afterEach(() => {
  stopRemoteAgentWatcher();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('remote agent watcher', () => {
  it('runs a single poll chain: one history request per interval', async () => {
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    const fetchHistory = stubFetch();

    await startAndSettle();

    const before = fetchHistory.mock.calls.length;
    await tick();
    const afterFirstTick = fetchHistory.mock.calls.length;

    // A second overlapping chain would make this delta 2.
    expect(afterFirstTick - before).toBe(1);

    startWatcher();
    await tick();
    expect(fetchHistory.mock.calls.length - afterFirstTick).toBe(1);
  });

  it('does not re-send a message this browser sent, even with whitespace drift', async () => {
    // content.ts records the trimmed textarea value; history stores it padded.
    recordLocalSentMessage('继续完成');
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    stubFetch();

    await startAndSettle();

    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, '\n继续完成\n'));
    await attempt();
    await attempt();

    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('re-sends a message from another device exactly once when it lands', async () => {
    const remoteMessage = '帮我把这篇文档翻译成英文';
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    stubFetch();
    onSend = appendEcho(CHAT_SESSION_ID, 3);

    await startAndSettle();

    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, remoteMessage));
    await attempt();
    await attempt();

    expect(sent).toEqual([remoteMessage]);
    expect(notices).toEqual([]);
  });

  // DPP-04 acceptance leg ①: 注入后 history 无该消息 ⇒ 游标不推进、待重发保留
  it('keeps the pending message when the resend leaves no trace in history', async () => {
    const remoteMessage = '远程发来的任务';
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    stubFetch();
    // No echo: the Enter never produced a message, so there is no receipt.

    await startAndSettle();

    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, remoteMessage));

    await attempt();
    expect(sent).toEqual([remoteMessage]);
    expect(notices).toEqual([]);

    // The cursor must still sit on message 1, so the next poll re-detects the
    // same remote message instead of treating it as handled.
    await attempt();
    expect(sent).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  // DPP-04 acceptance leg ②: 会话切换 ⇒ 本轮不推进
  it('does not move the cursor onto another session when the chat switches mid-receipt', async () => {
    const remoteMessage = '这条还欠一个回执';
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    // The other chat happens to hold the same text under its own ids, so a
    // content match alone would "confirm" a send that landed in the wrong chat.
    histories.set(OTHER_SESSION_ID, [userMessage(9001, '另一个会话'), userMessage(9002, remoteMessage)]);
    stubFetch();

    await startAndSettle();

    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, remoteMessage));
    await tick();
    expect(sent).toEqual([remoteMessage]);

    // The user opens a different chat while the receipt wait is running.
    window.history.pushState({}, '', `/a/chat/s/${OTHER_SESSION_ID}`);
    await receiptWindow();
    await tick();

    // Back in the original chat the message is still owed: had the cursor been
    // pushed onto the other session's ids, this poll would stay silent.
    window.history.pushState({}, '', `/a/chat/s/${CHAT_SESSION_ID}`);
    await attempt();
    expect(sent).toHaveLength(2);
  });

  it('gives up after the retry cap and tells the user', async () => {
    const remoteMessage = '发不出去的那条';
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    stubFetch();

    await startAndSettle();
    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, remoteMessage));

    for (let i = 0; i < MAX_RETRIES; i++) {
      await attempt();
      expect(notices).toEqual([]);
    }
    expect(sent).toHaveLength(MAX_RETRIES);

    // The attempt after the cap notifies once and stops, rather than looping on
    // the same message for the rest of the session.
    await attempt();
    expect(sent).toHaveLength(MAX_RETRIES);
    expect(notices).toEqual([remoteMessage]);

    await attempt();
    expect(sent).toHaveLength(MAX_RETRIES);
    expect(notices).toEqual([remoteMessage]);
  });

  it('counts a resend that throws as a failed attempt and still notifies', async () => {
    const remoteMessage = '页面卡住时的消息';
    histories.set(CHAT_SESSION_ID, [userMessage(1, '已有的历史消息')]);
    stubFetch();

    await startAndSettle();
    histories.get(CHAT_SESSION_ID)!.push(userMessage(2, remoteMessage));

    // A disabled/absent input is exactly how "Enter never landed" shows up.
    document.body.innerHTML = '';

    for (let i = 0; i < MAX_RETRIES + 1; i++) {
      await attempt();
    }

    expect(sent).toEqual([]);
    expect(notices).toEqual([remoteMessage]);
  });
});

describe('remote agent resend notice wiring', () => {
  it('hands the content script a notice callback when starting the watcher', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    const start = source.indexOf('startRemoteAgentWatcher({');
    expect(start).toBeGreaterThanOrEqual(0);
    const region = source.slice(start, start + 600);
    expect(region).toMatch(/onResendFailed/);
    expect(region).toMatch(/content\.remoteAgent\.resendFailed/);
    expect(region).toMatch(/showContentToast\(/);
  });
});
