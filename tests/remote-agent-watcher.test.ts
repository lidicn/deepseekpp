/**
 * Remote Agent watcher guardrails.
 *
 * The watcher polls DeepSeek's history API and re-injects a message it thinks
 * came from another device. These tests pin the two properties that keep that
 * from turning into "the extension typed my message a second time":
 *   - one poll chain runs, so each interval issues exactly one history request
 *   - a message this browser sent itself is never re-sent, even when the
 *     history copy differs in surrounding whitespace
 * The third test is the positive control for the second one: the same fixture
 * with a message this browser did *not* send must produce exactly one re-send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const POLL_INTERVAL_MS = 5_000;

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

function inputStub(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.id = 'chat-input';
  return el;
}

/**
 * resendMessageViaUI writes through the native prototype setter (so React
 * notices), so the spy has to sit on the prototype, not on the element.
 */
function spyOnTextAreaValue(): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set').mockImplementation(
    function setValue(this: HTMLTextAreaElement, value: string) {
      sent.push(value);
      nativeSetter?.call(this, value);
    },
  );
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

beforeEach(() => {
  sent.length = 0;
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
    const fetchHistory = vi.fn(async () =>
      historyResponse([userMessage(1, '已有的历史消息')]),
    );
    vi.stubGlobal('fetch', fetchHistory);

    startRemoteAgentWatcher({ chatSessionId: CHAT_SESSION_ID });
    await drain();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    await drain();
    expect(isRemoteAgentWatcherEnabled()).toBe(true);

    const before = fetchHistory.mock.calls.length;
    await tick();
    const afterFirstTick = fetchHistory.mock.calls.length;

    // A second overlapping chain would make this delta 2.
    expect(afterFirstTick - before).toBe(1);

    startRemoteAgentWatcher({ chatSessionId: CHAT_SESSION_ID });
    await tick();
    expect(fetchHistory.mock.calls.length - afterFirstTick).toBe(1);
  });

  it('does not re-send a message this browser sent, even with whitespace drift', async () => {
    // content.ts records the trimmed textarea value; history stores it padded.
    recordLocalSentMessage('继续完成');

    const history = [userMessage(1, '已有的历史消息')];
    const fetchHistory = vi.fn(async () => historyResponse(history));
    vi.stubGlobal('fetch', fetchHistory);

    startRemoteAgentWatcher({ chatSessionId: CHAT_SESSION_ID });
    await drain();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    await drain();

    history.push(userMessage(2, '\n继续完成\n'));
    await tick();
    await tick();

    expect(fetchHistory.mock.calls.length).toBeGreaterThan(1);
    expect(sent).toEqual([]);
  });

  it('re-sends a message from another device exactly once', async () => {
    const remoteMessage = '帮我把这篇文档翻译成英文';
    const history = [userMessage(1, '已有的历史消息')];
    const fetchHistory = vi.fn(async () => historyResponse(history));
    vi.stubGlobal('fetch', fetchHistory);

    startRemoteAgentWatcher({ chatSessionId: CHAT_SESSION_ID });
    await drain();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    await drain();

    history.push(userMessage(2, remoteMessage));
    await tick();
    // The watcher waits 3s after re-sending, then refreshes its last-seen id.
    await drain();
    vi.advanceTimersByTime(3_100);
    await drain();
    await tick();
    await tick();

    expect(sent).toEqual([remoteMessage]);
  });
});
