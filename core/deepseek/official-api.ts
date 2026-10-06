import {
  DEFAULT_OFFICIAL_API_CHAT_CONFIG,
  normalizeOfficialApiChatConfig,
  type OfficialApiChatConfig,
} from '../chat/official-api-config';
import {
  fetchWithNetworkPolicy,
  readNetworkResponseText,
} from '../network/request-policy';
import {
  createDeepSeekSseByteDecoder,
  parseSSEData,
  type SSEEvent,
} from './stream-codec';
import {
  DEEPSEEK_BODY_BUDGETS,
  DEEPSEEK_OFFICIAL_API_URL,
} from './contracts';

export { DEEPSEEK_OFFICIAL_API_URL } from './contracts';

export interface OfficialDeepSeekMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
}

export interface OfficialDeepSeekTurn {
  assistantText: string;
  reasoningText: string;
  finished: boolean;
}

export interface OfficialDeepSeekCallbacks {
  onTextChunk?(text: string, fullText: string): void;
  onReasoningChunk?(text: string, fullText: string): void;
  onFinished?(): void;
}

export interface SubmitOfficialDeepSeekInput {
  apiKey: string;
  config?: OfficialApiChatConfig;
  messages: OfficialDeepSeekMessage[];
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export class DeepSeekOfficialApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekOfficialApiError';
  }
}

/**
 * Ceiling for one official-API streaming completion. Applied regardless of
 * whether the caller supplies an AbortSignal: the signal handles cancellation,
 * while this deadline guards against a silently stalled stream. Previously the
 * deadline was omitted when a signal was present, but request-policy then
 * injected a 120s fallback that silently shortened caller-managed long streams
 * (audit issue #3). 300s matches INLINE_AGENT_STEP_TIMEOUT_MS.
 */
export const OFFICIAL_API_STREAM_DEADLINE_MS = 300_000;

export async function submitOfficialDeepSeekStreaming(
  input: SubmitOfficialDeepSeekInput,
  callbacks: OfficialDeepSeekCallbacks,
  signal?: AbortSignal,
): Promise<OfficialDeepSeekTurn> {
  const response = await fetchWithNetworkPolicy(input.endpoint ?? DEEPSEEK_OFFICIAL_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(createOfficialDeepSeekRequestBody(input)),
  }, {
    operation: 'DeepSeek official API completion',
    phase: 'completion',
    deadlineAt: Date.now() + OFFICIAL_API_STREAM_DEADLINE_MS,
    maxRequestBytes: DEEPSEEK_BODY_BUDGETS.officialApi,
    maxResponseBytes: DEEPSEEK_BODY_BUDGETS.officialApi,
    fetchImpl: input.fetchImpl,
  });

  if (!response.ok) {
    throw new DeepSeekOfficialApiError(await readOfficialApiFailure(response));
  }

  if (!response.body) {
    throw new DeepSeekOfficialApiError('DeepSeek official API response did not include a stream body.');
  }

  return readOfficialApiStream(response, callbacks);
}

export function createOfficialDeepSeekRequestBody(input: Pick<SubmitOfficialDeepSeekInput, 'config' | 'messages'>) {
  const config = normalizeOfficialApiChatConfig(input.config ?? DEFAULT_OFFICIAL_API_CHAT_CONFIG);
  return {
    model: config.model,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(config.thinking === 'enabled' && message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}),
    })),
    stream: true,
    thinking: {
      type: config.thinking,
    },
    ...(config.thinking === 'enabled' ? { reasoning_effort: config.reasoningEffort } : {}),
  };
}

async function readOfficialApiStream(
  response: Response,
  callbacks: OfficialDeepSeekCallbacks,
): Promise<OfficialDeepSeekTurn> {
  const reader = response.body!.getReader();
  const decoder = createDeepSeekSseByteDecoder();
  const turn: OfficialDeepSeekTurn = { assistantText: '', reasoningText: '', finished: false };

  let streamAbortedEarly = false;
  try {
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (readerErr) {
        // Partial completion handling: if we have streamed content before the
        // reader throws (timeout abort, connection reset), return the partial
        // turn so the caller can continue via nudge instead of terminating.
        const hasPartialContent = turn.assistantText !== '' || turn.reasoningText !== '';
        if (hasPartialContent) {
          streamAbortedEarly = true;
          break;
        }
        throw readerErr;
      }
      if (done) break;

      consumeOfficialApiSse(decoder.push(value!), turn, callbacks);
    }

    consumeOfficialApiSse(decoder.finish(), turn, callbacks);
  } finally {
    if (streamAbortedEarly) {
      try { await reader.cancel(); } catch { /* ignore cleanup errors */ }
    }
  }

  callbacks.onFinished?.();
  if (streamAbortedEarly) {
    turn.finished = false; // explicitly mark as incomplete
  }
  return turn;
}

function consumeOfficialApiSse(
  events: readonly SSEEvent[],
  turn: OfficialDeepSeekTurn,
  callbacks: OfficialDeepSeekCallbacks,
) {
  for (const event of events) {
    if (event.data === '[DONE]') {
      turn.finished = true;
      continue;
    }

    const parsed = parseSSEData(event.data);
    const newReasoningText = extractOfficialApiDeltaReasoningText(parsed);
    if (newReasoningText) {
      turn.reasoningText += newReasoningText;
      callbacks.onReasoningChunk?.(newReasoningText, turn.reasoningText);
    }

    const newText = extractOfficialApiDeltaText(parsed);
    if (newText) {
      turn.assistantText += newText;
      callbacks.onTextChunk?.(newText, turn.assistantText);
    }

    if (isOfficialApiFinished(parsed)) {
      turn.finished = true;
    }
  }
}

function extractOfficialApiDeltaReasoningText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';

  return choices
    .map((choice) => {
      if (!choice || typeof choice !== 'object') return '';
      const delta = (choice as { delta?: unknown }).delta;
      if (!delta || typeof delta !== 'object') return '';
      const content = (delta as { reasoning_content?: unknown; thinking_content?: unknown }).reasoning_content ??
        (delta as { thinking_content?: unknown }).thinking_content;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

function extractOfficialApiDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';

  return choices
    .map((choice) => {
      if (!choice || typeof choice !== 'object') return '';
      const delta = (choice as { delta?: unknown }).delta;
      if (!delta || typeof delta !== 'object') return '';
      const content = (delta as { content?: unknown }).content;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

function isOfficialApiFinished(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const choices = (parsed as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.some((choice) =>
    choice &&
    typeof choice === 'object' &&
    typeof (choice as { finish_reason?: unknown }).finish_reason === 'string'
  );
}

async function readOfficialApiFailure(response: Response): Promise<string> {
  const text = await readNetworkResponseText(response, 'DeepSeek official API completion');
  if (!text) return `DeepSeek official API failed with HTTP ${response.status}.`;

  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  } catch {}

  return text;
}
