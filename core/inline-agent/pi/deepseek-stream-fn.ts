/**
 * DeepSeek-web StreamFn adapter (Issue A1-T2).
 *
 * Wraps the DeepSeek web session as a pi `StreamFn` model backend:
 *
 *  - `createDeepSeekTurnSubmitter` — thin adapter over `submitPromptStreaming`
 *    that mirrors the original loop's turn semantics exactly: client headers +
 *    PoW headers created once per turn, a bounded single retry that is only
 *    allowed when no text chunk was received (retrying after streamed content
 *    could fork the conversation chain), and the 120s step timeout. The
 *    original loop's implementation is replaced by this module in Issue A3;
 *    until then the two copies share the extracted `step-control` helpers.
 *
 *  - `createDeepSeekStreamFn` — maps the DS-web text/tool-call stream into pi
 *    `AssistantMessageEventStream` protocol events. Never throws: request,
 *    model and runtime failures are encoded as protocol `error` events with a
 *    final AssistantMessage carrying stopReason "error"/"aborted"
 *    (StreamFn contract).
 *
 * The DS-web conversation chain stays the authority: `parentMessageId` is
 * read from and written back to the injected session state (never derived
 * from the pi context) — fail-closed against chain forks (risk (g)).
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createClientHeaders,
  createPowHeaders,
  submitPromptStreaming,
  type ModelTurn,
  type SubmitPromptInput,
} from '../../deepseek/adapter';
import { extractToolCalls } from '../../interceptor/tool-parser';
import { createStreamingToolCallParser } from '../../interceptor/streaming-tool-call-parser';
import { createStreamingToolTextAccumulator } from '../../interceptor/streaming-tool-text';
import type { ToolCall as CoreToolCall } from '../../types';
import { createStepSignal, waitBetweenDeepSeekRequests } from '../step-control';
import type {
  DeepSeekStreamFnDeps,
  DeepSeekTurnCallbacks,
  DeepSeekTurnRequest,
  DeepSeekTurnResult,
  DeepSeekTurnSubmitter,
  ParsedXmlToolCall,
} from './stream-fn-port';

const INLINE_AGENT_MAX_STEP_ATTEMPTS = 2;

export interface DeepSeekTurnSubmitterOptions {
  powWasmUrl?: string;
}

/**
 * Builds the turn submitter: one turn = one PoW solve + bounded no-chunk
 * retry + 120s step timeout, mirroring the original `submitAgentTurn`.
 */
export function createDeepSeekTurnSubmitter(
  options: DeepSeekTurnSubmitterOptions = {},
): DeepSeekTurnSubmitter {
  const { powWasmUrl } = options;

  return async (request, callbacks, signal) => {
    const clientHeaders = createClientHeaders();
    const powHeaders = await createPowHeaders(clientHeaders, powWasmUrl);
    const input: SubmitPromptInput = {
      chatSessionId: request.chatSessionId,
      parentMessageId: request.parentMessageId,
      modelType: request.modelType,
      prompt: request.prompt,
      refFileIds: request.refFileIds,
      thinkingEnabled: request.thinkingEnabled,
      searchEnabled: request.searchEnabled,
      clientHeaders,
      powHeaders,
    };
    return submitWithRetry(input, callbacks, signal);
  };
}

/**
 * Builds the pi StreamFn over the DS-web backend. The returned function never
 * rejects; failures are encoded as protocol events.
 */
export function createDeepSeekStreamFn(deps: DeepSeekStreamFnDeps): StreamFn {
  const { submitTurn, session, serializePrompt, mapToolCall, toolDescriptors, turnDefaults } = deps;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;

    const partial = createEmptyAssistantMessage(model);
    const emit = (event: AssistantMessageEvent) => stream.push(event);
    const snapshot = () => ({ ...partial, content: [...partial.content] });

    emit({ type: 'start', partial: snapshot() });

    void (async () => {
      try {
        const request: DeepSeekTurnRequest = {
          chatSessionId: session.chatSessionId,
          parentMessageId: session.parentMessageId,
          modelType: turnDefaults.modelType ?? model.id ?? null,
          prompt: serializePrompt(context),
          refFileIds: turnDefaults.refFileIds,
          thinkingEnabled: turnDefaults.thinkingEnabled,
          searchEnabled: turnDefaults.searchEnabled,
        };

        const textAccumulator = createStreamingToolTextAccumulator(toolDescriptors);
        const toolCallParser = createStreamingToolCallParser(toolDescriptors);
        let lastVisibleText = '';
        let textContentIndex: number | null = null;
        let thinkingContentIndex: number | null = null;
        let lastThinkingText = '';
        let toolCallCount = 0;
        // Raw (un-stripped) stream text for the released fallback parse:
        // legacy DSML blocks are invisible to the streaming XML parser and are
        // only recovered at flush time.
        let fallbackRawText = '';
        let fallbackRawTruncated = false;
        const FALLBACK_PARSE_MAX_CHARS = 120_000;

        const emitText = (fullText: string) => {
          const delta = fullText.slice(lastVisibleText.length);
          lastVisibleText = fullText;
          if (!delta) return;
          if (textContentIndex === null) {
            textContentIndex = partial.content.length;
            partial.content.push({ type: 'text', text: fullText });
            emit({ type: 'text_start', contentIndex: textContentIndex, partial: snapshot() });
          } else {
            partial.content[textContentIndex] = { type: 'text', text: fullText };
          }
          emit({ type: 'text_delta', contentIndex: textContentIndex, delta, partial: snapshot() });
        };

        const emitToolCall = (parsed: ParsedXmlToolCall) => {
          const toolCall = mapToolCall(parsed, toolCallCount);
          toolCallCount += 1;
          const contentIndex = partial.content.length;
          partial.content.push({ type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: {} });
          emit({ type: 'toolcall_start', contentIndex, partial: snapshot() });
          partial.content[contentIndex] = toolCall;
          emit({ type: 'toolcall_end', contentIndex, toolCall, partial: snapshot() });
        };

        const emitThinking = (fullText: string) => {
          const delta = fullText.slice(lastThinkingText.length);
          lastThinkingText = fullText;
          if (!delta) return;
          if (thinkingContentIndex === null) {
            thinkingContentIndex = partial.content.length;
            partial.content.push({ type: 'thinking', thinking: fullText });
            emit({ type: 'thinking_start', contentIndex: thinkingContentIndex, partial: snapshot() });
          } else {
            partial.content[thinkingContentIndex] = { type: 'thinking', thinking: fullText };
          }
          emit({ type: 'thinking_delta', contentIndex: thinkingContentIndex, delta, partial: snapshot() });
        };

        const onParsed = (parsed: { completed: CoreToolCall[]; failed: CoreToolCall[] }) => {
          for (const call of parsed.completed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
          for (const call of parsed.failed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
        };

        const callbacks: DeepSeekTurnCallbacks = {
          onTextChunk(text) {
            if (!fallbackRawTruncated) {
              if (fallbackRawText.length + text.length > FALLBACK_PARSE_MAX_CHARS) {
                fallbackRawTruncated = true;
                fallbackRawText = '';
              } else {
                fallbackRawText += text;
              }
            }
            emitText(textAccumulator.append(text));
            onParsed(toolCallParser.append(text));
          },
          onReasoningChunk(reasoning, fullReasoning) {
            emitThinking(fullReasoning);
          },
          onTokenSpeed(progress) {
            deps.onTokenSpeed?.(progress);
          },
        };

        const result = await submitTurn(request, callbacks, signal);

        // Graceful partial completion: the DeepSeek web stream can end before
        // FINISHED when the step timeout fires mid-response, the connection
        // drops, or the server interrupts. We now treat this as a recoverable
        // partial turn: the partial text/toolCalls already streamed through the
        // callbacks, so we emit what we have and let the pi loop's existing
        // nudge mechanism handle the continuation — the parentMessageId from
        // the partial turn is preserved so the next turn chains correctly.
        //
        // Before this fix, !finished && !aborted would throw an error that
        // became stopReason='error', terminating the entire agent loop as
        // AGENT_LOOP_ERROR. The user had to manually say "继续" to restart.
        //
        // User-initiated aborts keep their silent 'aborted' semantics.
        const isPartialCompletion = !result.finished && !signal?.aborted;

        // The conversation chain authority: the page session, not this turn's
        // transcript, owns the next parent message id. For partial completion,
        // we MUST preserve whatever responseMessageId we captured from the
        // partial stream — it's the only chain link we have.
        session.setParentMessageId(result.responseMessageId);

        onParsed(toolCallParser.flush());
        emitText(textAccumulator.flush());
        if (!fallbackRawTruncated && fallbackRawText) {
          const shouldFallback = fallbackRawText.includes('｜DSML｜')
            || (toolCallCount === 0 && fallbackRawText.includes('<'));
          if (shouldFallback) {
            for (const call of extractToolCalls(fallbackRawText, { descriptors: toolDescriptors })) {
              emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
            }
          }
        }
        if (textContentIndex !== null) {
          emit({
            type: 'text_end',
            contentIndex: textContentIndex,
            content: lastVisibleText,
            partial: snapshot(),
          });
        }
        if (thinkingContentIndex !== null) {
          emit({
            type: 'thinking_end',
            contentIndex: thinkingContentIndex,
            content: lastThinkingText,
            partial: snapshot(),
          });
        }

        // For partial completion, append a visible interruption marker so
        // the nudge prompt knows there's unfinished business to recover.
        if (isPartialCompletion && textContentIndex !== null) {
          const marker = '\n\n[Response interrupted mid-stream — continuing.]';
          const full = lastVisibleText + marker;
          partial.content[textContentIndex] = { type: 'text', text: full };
          lastVisibleText = full;
        }

        partial.stopReason = partial.content.some((block) => block.type === 'toolCall')
          ? 'toolUse'
          : 'stop';
        emit({ type: 'done', reason: partial.stopReason, message: snapshot() });
      } catch (err) {
        // All recoverable interruptions (timeout mid-stream, connection reset
        // mid-stream) are now handled by readCompletionStreamWithCallbacks
        // returning a partial result instead of throwing. This catch only fires
        // for fatal errors: network failure before any SSE events, PoW solve
        // failure, request rejection, etc. — emit error and let the loop die.
        const aborted = signal?.aborted ?? false;
        partial.stopReason = aborted ? 'aborted' : 'error';
        partial.errorMessage = aborted ? 'Aborted' : (err instanceof Error ? err.message : String(err));
        emit({ type: 'error', reason: partial.stopReason, error: snapshot() });
      }
    })();

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Submits one turn with a bounded single retry. A retry is only allowed when
 * the request failed before any text chunk was received: once the server has
 * streamed content the turn is likely committed server-side, and replaying it
 * with the same parent message could fork the conversation chain. User abort
 * is never retried. Mirrors the original loop's `submitAgentTurn`.
 */
async function submitWithRetry(
  input: SubmitPromptInput,
  callbacks: DeepSeekTurnCallbacks,
  parentSignal: AbortSignal | undefined,
): Promise<DeepSeekTurnResult> {
  const signal = parentSignal ?? new AbortController().signal;
  let receivedAnyChunk = false;

  for (let attempt = 1; attempt <= INLINE_AGENT_MAX_STEP_ATTEMPTS; attempt++) {
    const stepTimeout = createStepSignal(signal);
    try {
      const turn: ModelTurn = await submitPromptStreaming(input, {
        retainAssistantText: false,
        onTextChunk(text, fullText) {
          receivedAnyChunk = true;
          callbacks.onTextChunk(text, fullText);
        },
        onReasoningChunk(reasoning, fullReasoning) {
          // Reasoning deltas are streamed content too: a turn that only
          // streamed thinking before timing out must NOT be resubmitted with
          // the same parent_message_id (the server may have already committed
          // the response, forking the conversation chain).
          receivedAnyChunk = true;
          callbacks.onReasoningChunk?.(reasoning, fullReasoning);
        },
        onTokenSpeed: callbacks.onTokenSpeed,
      }, stepTimeout.signal);
      return {
        assistantText: turn.assistantText,
        responseMessageId: turn.responseMessageId,
        requestMessageId: turn.requestMessageId,
        finished: turn.finished,
      };
    } catch (err) {
      if (signal.aborted) throw err;
      const timeoutFired = stepTimeout.timedOut();
      if (timeoutFired && receivedAnyChunk) {
        throw new Error('DeepSeek agent step timed out while streaming; the response was interrupted.');
      }
      if (attempt >= INLINE_AGENT_MAX_STEP_ATTEMPTS) {
        if (timeoutFired) throw new Error('DeepSeek agent step timed out after retry.');
        throw err;
      }
      await waitBetweenDeepSeekRequests(signal);
      if (signal.aborted) throw err;
    } finally {
      stepTimeout.clear();
    }
  }
  throw new Error('DeepSeek agent step failed without a completed attempt.');
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
  const emptyUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
