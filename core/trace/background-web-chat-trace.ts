/**
 * Background web-chat W29 trace recorder (第十二批 P0-2).
 *
 * Sidepanel chat runs in the service worker. Content-side `emitTraceEvent`
 * sinks never fire here, so web-path runs historically wrote zero
 * `dpp_inline_agent_traces` records. This module reuses the same
 * `createTurnTracker` + `report.ts` event model and persists into the
 * existing `dpp_inline_agent_traces` slot (no new storage key).
 */
import { createTurnTracker, type TurnTracker } from './turn-tracker';
import type { TraceEvent } from './report';
import type { InlineAgentTraceRecord } from '../inline-agent/types';
import { upsertPersistedInlineAgentTrace } from '../inline-agent/trace-store';

export interface BackgroundWebChatTraceMeta {
  chatSessionId: string;
  originalPrompt: string;
  agentTaskPrompt?: string;
  finalText: string;
  totalTools: number;
  status: 'complete' | 'error';
  url?: string;
}

export interface BackgroundWebChatTrace {
  /** Start a model-request turn. Returns the tracker turnId. */
  beginTurn(prefix?: string): string;
  requestSent(bytes: number, powMs?: number): void;
  sseFrame(kind: 'text' | 'think' | 'tool'): void;
  toolExec(name: string, durationMs: number | undefined, ok: boolean): void;
  endTurn(stopReason: string, finished: boolean): void;
  snapshot(): readonly TraceEvent[];
  /** Best-effort persist into dpp_inline_agent_traces. Never throws. */
  persist(meta: BackgroundWebChatTraceMeta): Promise<void>;
}

export function createBackgroundWebChatTrace(
  options: { now?: () => number; limit?: number } = {},
): BackgroundWebChatTrace {
  const tracker: TurnTracker = createTurnTracker(options);
  const createdAt = options.now?.() ?? Date.now();

  return {
    beginTurn(prefix = 'web-chat'): string {
      return tracker.startTurn(prefix);
    },
    requestSent(bytes: number, powMs?: number): void {
      tracker.requestSent(bytes, powMs);
    },
    sseFrame(kind): void {
      tracker.sseFrame(kind);
    },
    toolExec(name, durationMs, ok): void {
      tracker.toolExec(name, durationMs, ok);
    },
    endTurn(stopReason, finished): void {
      tracker.endTurn(stopReason, finished);
    },
    snapshot(): readonly TraceEvent[] {
      return tracker.snapshot();
    },
    async persist(meta: BackgroundWebChatTraceMeta): Promise<void> {
      const events = tracker.snapshot();
      if (events.length === 0) return;
      const loopId = `web-chat-${createdAt}`;
      const record: InlineAgentTraceRecord = {
        id: loopId,
        loopId,
        chatSessionId: meta.chatSessionId,
        anchorMessageId: 0,
        url: meta.url ?? '',
        originalPrompt: meta.originalPrompt,
        agentTaskPrompt: meta.agentTaskPrompt ?? meta.originalPrompt,
        status: meta.status,
        steps: [],
        events: [...events],
        totalSteps: events.filter((e) => e.t === 'turn.start').length,
        totalTools: meta.totalTools,
        finalText: meta.finalText,
        createdAt,
        updatedAt: options.now?.() ?? Date.now(),
      };
      try {
        await upsertPersistedInlineAgentTrace(record);
      } catch (error) {
        console.warn('[DeepSeek++] background web-chat trace write failed:', error);
      }
    },
  };
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
