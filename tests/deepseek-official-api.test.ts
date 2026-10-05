import { afterEach, describe, expect, it, vi } from 'vitest';
import { INLINE_AGENT_STEP_TIMEOUT_MS } from '../core/inline-agent/types';
import {
  createOfficialDeepSeekRequestBody,
  DEEPSEEK_OFFICIAL_API_URL,
  OFFICIAL_API_STREAM_DEADLINE_MS,
  submitOfficialDeepSeekStreaming,
} from '../core/deepseek/official-api';

afterEach(() => {
  vi.useRealTimers();
});

describe('DeepSeek official API adapter', () => {
  it('builds current official model and thinking request bodies', () => {
    expect(createOfficialDeepSeekRequestBody({
      config: {
        model: 'deepseek-v4-flash',
        thinking: 'disabled',
        reasoningEffort: 'high',
      },
      messages: [{ role: 'user', content: 'hello' }],
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      stream: true,
    });

    expect(createOfficialDeepSeekRequestBody({
      config: {
        model: 'deepseek-v4-pro',
        thinking: 'enabled',
        reasoningEffort: 'max',
      },
      messages: [{ role: 'user', content: 'hello' }],
    })).toMatchObject({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      stream: true,
    });
  });

  it('streams OpenAI-compatible reasoning and answer deltas with the configured API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => createSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"Think"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n')));
    const chunks: string[] = [];
    const reasoningChunks: string[] = [];

    const turn = await submitOfficialDeepSeekStreaming({
      apiKey: 'sk-test',
      config: {
        model: 'deepseek-v4-flash',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl,
    }, {
      onTextChunk(chunk) {
        chunks.push(chunk);
      },
      onReasoningChunk(chunk) {
        reasoningChunks.push(chunk);
      },
    });

    expect(turn).toEqual({ assistantText: 'Hello', reasoningText: 'Think', finished: true });
    expect(chunks).toEqual(['Hel', 'lo']);
    expect(reasoningChunks).toEqual(['Think']);
    expect(fetchImpl).toHaveBeenCalledWith(DEEPSEEK_OFFICIAL_API_URL, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer sk-test',
      }),
    }));

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  it('surfaces official API error messages', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401 },
    ));

    await expect(submitOfficialDeepSeekStreaming({
      apiKey: 'bad-key',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl,
    }, {})).rejects.toThrow('invalid api key');
  });

  it('passes reasoning content back for thinking tool loops', () => {
    expect(createOfficialDeepSeekRequestBody({
      config: {
        model: 'deepseek-v4-pro',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
      messages: [
        { role: 'assistant', content: 'final', reasoningContent: 'private trace' },
        { role: 'user', content: 'next' },
      ],
    }).messages[0]).toMatchObject({
      role: 'assistant',
      content: 'final',
      reasoning_content: 'private trace',
    });
  });

  it('omits reasoning content when thinking is disabled', () => {
    expect(createOfficialDeepSeekRequestBody({
      config: {
        model: 'deepseek-v4-flash',
        thinking: 'disabled',
        reasoningEffort: 'high',
      },
      messages: [
        { role: 'assistant', content: 'final', reasoningContent: 'private trace' },
      ],
    }).messages[0]).toEqual({
      role: 'assistant',
      content: 'final',
    });
  });

  it('documents the streaming ceiling at one inline-agent step budget', () => {
    expect(OFFICIAL_API_STREAM_DEADLINE_MS).toBe(INLINE_AGENT_STEP_TIMEOUT_MS);
    expect(OFFICIAL_API_STREAM_DEADLINE_MS).toBe(300_000);
  });

  it('bounds a signal-less streaming request with a default deadline signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => createSseResponse(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]',
    ));

    await submitOfficialDeepSeekStreaming({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl,
    }, {});

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('cuts a stalled signal-less stream at the deadline and returns the partial turn', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
          ));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const pending = submitOfficialDeepSeekStreaming({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl,
    }, {});

    await vi.advanceTimersByTimeAsync(OFFICIAL_API_STREAM_DEADLINE_MS + 50);

    await expect(pending).resolves.toEqual({
      assistantText: 'Hel',
      reasoningText: '',
      finished: false,
    });
  });

  it('passes a caller-supplied signal through untouched instead of imposing the default', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => createSseResponse(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]',
    ));

    await submitOfficialDeepSeekStreaming({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl,
    }, {}, controller.signal);

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});

function createSseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
