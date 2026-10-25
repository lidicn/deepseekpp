import { createAbortScope, type AbortScope } from './abort';

/**
 * Fallback timeout when a caller omits deadlineAt AND supplies no AbortSignal.
 * DPP-034: without this, an undefined deadlineAt on a signal-less request yields
 * a scope with no timeout at all (timedOut() === false forever), which can
 * permanently hang background automation links. 120s is generous for network
 * requests while still guaranteeing eventual cleanup.
 *
 * Important: this fallback does NOT apply when the caller supplies an
 * AbortSignal — in that case the caller owns cancellation and no deadline is
 * injected (see createRequestScope). This prevents silent truncation of
 * caller-managed long streams like web completion.
 */
const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000;

/**
 * Audit fix S-4: absolute ceiling for caller-managed (signal-present but no
 * deadlineAt) requests. Without this, any path that passes a signal but forgets
 * deadlineAt (e.g. createChatSession, readHistorySnapshot) runs with zero
 * timeout protection and can hang forever. 600s (10 min) is far beyond any
 * normal short-request budget but still guarantees eventual cleanup.
 * Completion streams explicitly set their own 300s deadline and are unaffected.
 */
const MAX_CALLER_MANAGED_TIMEOUT_MS = 600_000;

export type NetworkPolicyErrorCode =
  | 'network_deadline_exceeded'
  | 'network_request_failed'
  | 'network_request_too_large'
  | 'network_response_too_large'
  | 'network_response_unreadable';

export class NetworkPolicyError extends Error {
  readonly retryable: boolean;
  readonly phase: string | null;

  constructor(
    readonly code: NetworkPolicyErrorCode,
    readonly operation: string,
    message: string,
    options?: { retryable?: boolean; phase?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NetworkPolicyError';
    this.retryable = options?.retryable ?? true;
    this.phase = options?.phase ?? null;
  }
}

export interface NetworkRequestPolicy {
  readonly operation: string;
  readonly phase?: string;
  readonly deadlineAt?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl?: typeof fetch;
  readonly onDispatch?: () => void;
  /**
   * Caller-provided cancellation signal handed to fetch verbatim (identity
   * preserved, Object.is equal). Use only where the caller's own AbortController
   * must drive cancellation on the exact signal it owns; the derived scope still
   * records callerSignal for abort-reason pass-through classification.
   */
  readonly callerSignal?: AbortSignal;
}

interface RequestScope {
  readonly signal?: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly timedOut: () => boolean;
  cleanup(): void;
}

export async function fetchWithNetworkPolicy(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: NetworkRequestPolicy,
): Promise<Response> {
  assertRequestWithinPolicy(init.body, policy);
  // policy.callerSignal is the authoritative cancellation signal; init.signal
  // remains the fallback for callers that only populate the RequestInit.
  const scope = createRequestScope(policy.callerSignal ?? init.signal, policy);
  const fetchImpl = policy.fetchImpl ?? fetch;
  // When an explicit callerSignal is supplied, hand that exact signal to fetch
  // so cancellation fires on the caller's own controller (identity preserved);
  // otherwise pass the derived scope signal so the policy deadline can cancel.
  const fetchSignal = policy.callerSignal ?? scope.signal;
  let response: Response;

  try {
    policy.onDispatch?.();
    response = await fetchImpl(input, { ...init, signal: fetchSignal });
  } catch (error) {
    scope.cleanup();
    throw classifyNetworkFailure(error, scope, policy, 'request');
  }

  if (scope.signal?.aborted) {
    await cancelResponseBody(response, abortReason(scope, policy));
    scope.cleanup();
    throw abortReason(scope, policy);
  }

  if (!response.body) {
    scope.cleanup();
    return response;
  }

  return wrapResponseBody(response, scope, policy);
}

/**
 * 审计 #10（2026-10-24 报告 P1）：原来只对 **string** body 计字节数，
 * `Blob` / `FormData` / `ArrayBuffer` 全部绕过 `maxRequestBytes` 预算 ——
 * `uploadDeepSeekFile` 传 FormData、多模态路径传 Blob，都能突破内存上限。
 *
 * 尽量量出真实字节数；量不出来（ReadableStream 等）返回 `null`，
 * 由调用方保持原有「不阻断未知形状」的行为。
 */
function measureBodyBytes(body: BodyInit): number | null {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const [, value] of body.entries()) {
      if (typeof value === 'string') total += new TextEncoder().encode(value).byteLength;
      else total += value.size;
    }
    return total;
  }
  // ReadableStream 等无法预知长度：不做估算（流式路径另有上限保护）
  return null;
}

function assertRequestWithinPolicy(
  body: BodyInit | null | undefined,
  policy: NetworkRequestPolicy,
): void {
  if (body == null || policy.maxRequestBytes === undefined) return;
  const byteLength = measureBodyBytes(body);
  if (byteLength === null) return;
  if (byteLength <= policy.maxRequestBytes) return;
  throw new NetworkPolicyError(
    'network_request_too_large',
    policy.operation,
    `${policy.operation} request exceeded ${policy.maxRequestBytes} bytes.`,
    { retryable: false, phase: policy.phase },
  );
}

export async function readNetworkResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof NetworkPolicyError || isAbortError(error)) throw error;
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new NetworkPolicyError(
      'network_response_unreadable',
      operation,
      `${operation} response body could not be read.`,
      { cause: error },
    );
  }
}

export async function cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel(reason);
  } catch {
    // The body may already be locked or settled; cancellation is best effort cleanup only.
  }
}

function createRequestScope(
  callerSignal: AbortSignal | null | undefined,
  policy: NetworkRequestPolicy,
): RequestScope {
  const { deadlineAt, operation } = policy;
  if (callerSignal?.aborted) throwSignalReason(callerSignal, operation);

  // When the caller supplies an AbortSignal but omits deadlineAt, the caller
  // owns cancellation — but we still apply an absolute ceiling (S-4) so that
  // a forgotten deadline cannot hang forever. Completion streams set their own
  // explicit 300s deadline and are unaffected by this ceiling.
  if (deadlineAt === undefined && callerSignal) {
    const abortScope = createAbortScope(callerSignal, MAX_CALLER_MANAGED_TIMEOUT_MS);
    return {
      signal: abortScope.signal,
      callerSignal,
      timedOut: abortScope.timedOut,
      cleanup: abortScope.cleanup,
    };
  }

  // DPP-034: when there is no callerSignal (e.g. background automation links),
  // a missing deadlineAt would yield a scope with no timeout at all and could
  // permanently hang. Fall back to 120s only in this no-signal case.
  const effectiveDeadline = deadlineAt ?? Date.now() + DEFAULT_FALLBACK_TIMEOUT_MS;

  const timeoutMs = effectiveDeadline - Date.now();
  if (timeoutMs <= 0) {
    throw new NetworkPolicyError(
      'network_deadline_exceeded',
      operation,
      `${operation} exceeded its execution deadline.`,
      { retryable: false, phase: policy.phase },
    );
  }

  const abortScope: AbortScope = createAbortScope(callerSignal, timeoutMs);
  return {
    signal: abortScope.signal,
    callerSignal: callerSignal ?? undefined,
    timedOut: abortScope.timedOut,
    cleanup: abortScope.cleanup,
  };
}

function wrapResponseBody(
  response: Response,
  scope: RequestScope,
  policy: NetworkRequestPolicy,
): Response {
  const reader = response.body!.getReader();
  let totalBytes = 0;
  let settled = false;
  let terminalPromise: Promise<void> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    scope.signal?.removeEventListener('abort', onAbort);
    scope.cleanup();
  };
  const fail = (error: unknown): Promise<void> => {
    if (terminalPromise) return terminalPromise;
    if (settled) return Promise.resolve();
    settled = true;
    cleanup();
    terminalPromise = reader.cancel(error)
      .catch(() => undefined)
      .then(() => {
        controllerRef?.error(error);
      });
    return terminalPromise;
  };
  const onAbort = () => {
    void fail(abortReason(scope, policy));
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      scope.signal?.addEventListener('abort', onAbort, { once: true });
      if (scope.signal?.aborted) onAbort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        const chunk = await reader.read();
        if (settled) return;
        if (scope.signal?.aborted) {
          onAbort();
          return;
        }
        if (chunk.done) {
          settled = true;
          cleanup();
          controller.close();
          return;
        }

        totalBytes += chunk.value.byteLength;
        if (totalBytes > policy.maxResponseBytes) {
          await fail(new NetworkPolicyError(
            'network_response_too_large',
            policy.operation,
            `${policy.operation} response exceeded ${policy.maxResponseBytes} bytes.`,
            { retryable: false, phase: policy.phase },
          ));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await fail(classifyNetworkFailure(error, scope, policy, 'response'));
      }
    },
    async cancel(reason) {
      if (terminalPromise) {
        await terminalPromise;
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function classifyNetworkFailure(
  error: unknown,
  scope: RequestScope,
  policy: NetworkRequestPolicy,
  phase: 'request' | 'response',
): unknown {
  const { operation } = policy;
  if (scope.callerSignal?.aborted) return signalReason(scope.callerSignal, operation);
  if (scope.timedOut()) {
    return new NetworkPolicyError(
      'network_deadline_exceeded',
      operation,
      `${operation} exceeded its execution deadline.`,
      { retryable: false, phase: policy.phase, cause: error },
    );
  }
  if (error instanceof NetworkPolicyError || isAbortError(error)) return error;
  return new NetworkPolicyError(
    phase === 'request' ? 'network_request_failed' : 'network_response_unreadable',
    operation,
    phase === 'request'
      ? `${operation} request failed before a response was received.`
      : `${operation} response body could not be read.`,
    { phase: policy.phase, cause: error },
  );
}

function abortReason(scope: RequestScope, policy: NetworkRequestPolicy): unknown {
  const { operation } = policy;
  if (scope.callerSignal?.aborted) return signalReason(scope.callerSignal, operation);
  if (scope.timedOut()) {
    return new NetworkPolicyError(
      'network_deadline_exceeded',
      operation,
      `${operation} exceeded its execution deadline.`,
      { retryable: false, phase: policy.phase },
    );
  }
  if (scope.signal?.reason instanceof Error) return scope.signal.reason;
  return new DOMException(`${operation} was aborted.`, 'AbortError');
}

function signalReason(signal: AbortSignal, operation: string): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(`${operation} was aborted.`, 'AbortError');
}

function throwSignalReason(signal: AbortSignal, operation: string): never {
  throw signalReason(signal, operation);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
