import {
  consumeDeepSeekSseEvents,
  createDeepSeekSseByteDecoder,
  createDeepSeekStreamSummary,
  extractResponseUsageStatsFromParsed,
  extractResponseTextForTokenSpeed,
  getDeepSeekFragmentState,
  isStreamFinishedFromParsed,
  type SSEEvent,
} from './stream-codec';
import { diagnosticLogBuffer } from '../diagnostics/log-buffer';
import {
  createResponseTokenSpeedTracker,
  type ResponseTokenSpeedPayload,
} from './stream-metrics';
import {
  NetworkPolicyError,
  cancelResponseBody,
  fetchWithNetworkPolicy,
  readNetworkResponseText,
} from '../network/request-policy';
import {
  solvePowChallengeLocally,
  throwIfPowAborted,
  type PowAnswer,
  type PowChallenge,
} from './pow';
import { DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES } from './upload-limits';
import {
  DEEPSEEK_BYPASS_HOOK_HEADER,
  DEEPSEEK_BODY_BUDGETS,
  DEEPSEEK_FILE_FETCH_PATH,
  DEEPSEEK_FILE_UPLOAD_PATH,
  DEEPSEEK_WEB_ROUTES,
  type DeepSeekUploadedFile,
} from './contracts';
import {
  buildDeepSeekWebSessionUrl,
  encodeDeepSeekRouteRequest,
  encodeCompletionRequest,
  encodeCreateSessionRequest,
  encodeHistoryRequest,
  encodePowChallengeRequest,
  normalizeDeepSeekMessageId,
  normalizeDeepSeekModelType,
} from './request-codec';
import {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from './errors';
import type {
  DeepSeekAutomationClient,
  DeepSeekHistorySnapshot,
  DeepSeekRequestContext,
  ModelTurn,
  SubmitPromptInput,
} from './automation-client-port';

export {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from './errors';
export type {
  DeepSeekAutomationClient,
  DeepSeekHistorySnapshot,
  DeepSeekRequestContext,
  ModelTurn,
  SubmitPromptInput,
} from './automation-client-port';

const COMPLETION_PATH = DEEPSEEK_WEB_ROUTES.completion;

/**
 * Streaming budget for a single web completion turn. Matches
 * OFFICIAL_API_STREAM_DEADLINE_MS (300s) and INLINE_AGENT_STEP_TIMEOUT_MS.
 * Without this, request-policy falls back to 120s and long/deep-thinking
 * answers are silently truncated at the 2-minute mark (audit issue #1).
 */
const WEB_COMPLETION_STREAM_DEADLINE_MS = 300_000;

/** R05 心跳判定结果：是否记一次停滞，以及更新后的「已记录时间」。 */
export interface StreamStallDecision {
  stalled: boolean;
  nextLoggedAt: number;
}

/**
 * R05 流式心跳纯判定（零 IO，可单测）：
 * - 距 lastFrameAt 未超 warnMs → 未停滞，不记；
 * - 已停滞但距上次记录未超 warnMs → 去重，不重复刷屏；
 * - 否则记一次，nextLoggedAt=now。
 * 只做可见化，不主动断开（避免误杀长思考）。
 */
export function evaluateStreamStall(
  now: number,
  lastFrameAt: number,
  lastLoggedAt: number,
  warnMs: number,
): StreamStallDecision {
  if (now - lastFrameAt <= warnMs) return { stalled: false, nextLoggedAt: lastLoggedAt };
  if (now - lastLoggedAt <= warnMs) return { stalled: false, nextLoggedAt: lastLoggedAt };
  return { stalled: true, nextLoggedAt: now };
}

export { DEEPSEEK_FILE_FETCH_PATH, DEEPSEEK_FILE_UPLOAD_PATH } from './contracts';
export { DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES } from './upload-limits';
const DEFAULT_APP_VERSION = '2.0.0';
const DEEPSEEK_CLIENT_PLATFORM = 'web';
const USER_TOKEN_STORAGE_KEY = 'userToken';
const TOKEN_SPEED_EMIT_INTERVAL_MS = 250;
export const FILE_READY_POLL_INTERVAL_MS = 500;
const FILE_READY_TIMEOUT_MS = 15_000;
// DeepSeek can return audit_result=unknown together with status=SUCCESS for usable image uploads.
const ACCEPTED_FILE_AUDIT_RESULTS = new Set(['PASS', 'PASSED', 'SUCCESS', 'OK', 'UNKNOWN']);
const REJECTED_FILE_AUDIT_RESULTS = new Set(['REJECT', 'REJECTED', 'FAIL', 'FAILED', 'ERROR', 'BLOCK', 'BLOCKED', 'DENY', 'DENIED']);

let rememberedClientHeaders: Record<string, string> | null = null;

interface DeepSeekHistoryMessage {
  id: number | null;
  parentId: number | null;
  role: string | null;
}

export interface DeepSeekFileUploadInput {
  file: Blob;
  filename: string;
  modelType: string | null;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

export type { DeepSeekUploadedFile } from './contracts';

export interface StreamCallbacks {
  onTextChunk?(text: string, fullText: string): void;
  /** Reasoning/thinking deltas of the current response (THINK fragments). */
  onReasoningChunk?(reasoning: string, fullReasoning: string): void;
  onTokenSpeed?(progress: ResponseTokenSpeedPayload): void;
  onFinished?(): void;
  retainAssistantText?: boolean;
}

export function createDeepSeekAutomationClient(
  dependencies: { fetchImpl?: typeof fetch } = {},
): DeepSeekAutomationClient {
  const withDependencies = (context: DeepSeekRequestContext): DeepSeekRequestContext => ({
    ...context,
    fetchImpl: context.fetchImpl ?? dependencies.fetchImpl,
  });

  return {
    createClientHeaders,
    createChatSession: (clientHeaders, context) =>
      createChatSessionWithContext(clientHeaders, withDependencies(context)),
    createPowHeaders: (clientHeaders, context) =>
      createPowHeadersForPathWithContext(
        clientHeaders,
        COMPLETION_PATH,
        undefined,
        withDependencies(context),
      ),
    submitPrompt: (input, context) => submitPromptWithContext(input, withDependencies(context)),
    readHistorySnapshot: (chatSessionId, expectedAssistantMessageId, clientHeaders, context) =>
      readHistorySnapshotWithContext(
        chatSessionId,
        expectedAssistantMessageId,
        clientHeaders,
        withDependencies(context),
      ),
    normalizeMessageId,
    buildSessionUrl: buildDeepSeekSessionUrl,
  };
}

export async function createChatSession(
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  return createChatSessionWithContext(clientHeaders, { signal });
}

/**
 * 新建对话会话的重试预算。
 *
 * 2026-10-22 真机复查：用户报「新对话最开头高概率报 服务器暂时不可用」。
 * 排查确认这个文案不是扩展产生的（源码里除本段注释外无此字符串），
 * 它来自 DeepSeek 自己的 503 空体。而 `active-client.ts:222-225` 的 R-7
 * 注释早就点名过：「fetch 抛 TypeError 或 503 空体时一次即溃 ——
 * 这正是『新建对话最开头 服务器暂时不可用』的主因」。
 *
 * R-7 已经把网络异常包进 try 并加了退避，但预算偏小：
 * 原配置 3 次尝试、总等待仅 300+900+2700 = 3.9s。
 * DeepSeek 的 503 抖动常持续十几秒，3.9s 内打不满就必然暴露给用户。
 *
 * 现在放宽到 5 次、总等待约 15.5s（300/900/2700/5400/6000）。
 * 若响应带 `Retry-After`，retryDelayMs() 优先采用它（上限 30s，带抖动），
 * 也就是服务端给了更明确的等待指令时以它为准。
 *
 * 5xx / 429 / 传输层 TypeError 才重试；4xx 与 AuthError 仍然立即抛，
 * 不做无意义的等待。
 */
const CREATE_SESSION_RETRY_ATTEMPTS = 5;
const CREATE_SESSION_BACKOFF_MS = [300, 900, 2_700, 5_400, 6_000];

async function createChatSessionWithContext(
  clientHeaders: Record<string, string>,
  context: DeepSeekRequestContext,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CREATE_SESSION_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await requestDeepSeek(
        encodeCreateSessionRequest(clientHeaders),
        'DeepSeek chat session create',
        'session',
        context,
      );
      const json = await readJsonResponse(response, 'DeepSeek chat session create', 'session');
      const data = json?.data;
      const chatSessionId = firstString(data?.biz_data?.chat_session?.id);

      if (isAuthBizError(data, json)) {
        throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating chat session: ${JSON.stringify(data ?? json)}`);
      }

      if (response.ok && data?.biz_code === 0 && chatSessionId) {
        return chatSessionId;
      }

      // T4-2/T4-5: only 429 and 5xx are retryable with bounded exponential backoff;
      // other failures (4xx payload issues) surface immediately.
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new DeepSeekSessionError(`Failed to create DeepSeek chat session: ${JSON.stringify(data ?? json)}`);
      if (!retryable || attempt >= CREATE_SESSION_RETRY_ATTEMPTS) break;
      await sleep(retryDelayMs(response, CREATE_SESSION_BACKOFF_MS[attempt - 1] ?? 2700), context.signal);
    } catch (error) {
      // R-7: 旧版 attempt 体在 try 外，fetch 抛 TypeError（Failed to fetch）或 readJsonResponse
      // 抛 503 空体 NetworkPolicyError 时直接逃出循环、一次即溃——这正是「新建对话最开头
      // 服务器暂时不可用」的主因。包进 try 后：AbortError（用户取消）与 AuthError 立即抛；
      // 可重试的传输层错误（TypeError 或带 retryable 标志的网络策略错误）走退避；其余直接抛。
      const err = error as { name?: string; retryable?: boolean };
      if (err?.name === 'AbortError' || error instanceof DeepSeekAuthError) throw error;
      const transportRetryable = err?.name === 'TypeError' || err?.retryable === true;
      if (!transportRetryable || attempt >= CREATE_SESSION_RETRY_ATTEMPTS) throw error;
      lastError = error;
      await sleep(CREATE_SESSION_BACKOFF_MS[attempt - 1] ?? 2700, context.signal);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new DeepSeekSessionError('Failed to create DeepSeek chat session.');
}

export async function createPowHeaders(
  clientHeaders: Record<string, string>,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return createPowHeadersForPathWithContext(clientHeaders, COMPLETION_PATH, wasmUrl, { signal });
}

export async function createPowHeadersForPath(
  clientHeaders: Record<string, string>,
  targetPath: string,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return createPowHeadersForPathWithContext(clientHeaders, targetPath, wasmUrl, { signal });
}

async function createPowHeadersForPathWithContext(
  clientHeaders: Record<string, string>,
  targetPath: string,
  wasmUrl: string | undefined,
  context: DeepSeekRequestContext,
): Promise<Record<string, string>> {
  try {
    const challenge = await createPowChallenge(clientHeaders, targetPath, context);
    assertSignalActive(context.signal);
    const answer = await solvePowChallenge(challenge, wasmUrl, context.signal);
    assertSignalActive(context.signal);
    return {
      'X-DS-PoW-Response': base64EncodeUtf8(JSON.stringify({
        algorithm: answer.algorithm,
        challenge: answer.challenge,
        salt: answer.salt,
        answer: answer.answer,
        signature: answer.signature,
        target_path: targetPath,
      })),
    };
  } catch (err) {
    if (context.signal?.aborted) assertSignalActive(context.signal);
    if (err instanceof DeepSeekPowError) throw err;
    if (err instanceof DeepSeekAuthError) throw err;
    if (err instanceof NetworkPolicyError) throw err;
    throw new DeepSeekPowError(err instanceof Error ? err.message : String(err));
  }
}

function assertSignalActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('DeepSeek request was aborted.', 'AbortError');
}

export function createClientHeaders(options?: { missingTokenMessage?: string }): Record<string, string> {
  if (rememberedClientHeaders) return { ...rememberedClientHeaders };

  const token = readDeepSeekUserToken();
  if (!token) {
    throw new DeepSeekAuthError(
      options?.missingTokenMessage ?? 'DeepSeek login token is missing. Refresh chat.deepseek.com or sign in again.',
    );
  }

  return {
    Authorization: `Bearer ${token}`,
    'X-App-Version': getDeepSeekAppVersion(),
    'x-client-platform': DEEPSEEK_CLIENT_PLATFORM,
    'x-client-version': getDeepSeekAppVersion(),
    'x-client-locale': getDeepSeekLocale(),
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

export function rememberDeepSeekClientHeaders(headersInit: HeadersInit | undefined): void {
  const headers = normalizeHeaders(headersInit);
  if (!headers) return;

  const authorization = headers.get('authorization');
  if (!authorization) return;

  rememberedClientHeaders = {
    Authorization: authorization,
    'X-App-Version': headers.get('x-app-version') || getDeepSeekAppVersion(),
    'x-client-platform': headers.get('x-client-platform') || DEEPSEEK_CLIENT_PLATFORM,
    'x-client-version': headers.get('x-client-version') || getDeepSeekAppVersion(),
    'x-client-locale': headers.get('x-client-locale') || getDeepSeekLocale(),
    'x-client-timezone-offset': headers.get('x-client-timezone-offset') || String(-new Date().getTimezoneOffset() * 60),
  };
}

const STORAGE_HEADERS_KEY = 'deepseekCachedClientHeaders';

export async function saveClientHeadersToStorage(): Promise<boolean> {
  if (!rememberedClientHeaders) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_HEADERS_KEY]: rememberedClientHeaders });
    return true;
  } catch {
    return false;
  }
}

export async function loadClientHeadersFromStorage(): Promise<Record<string, string> | null> {
  try {
    const data = await chrome.storage.local.get(STORAGE_HEADERS_KEY);
    const headers = data[STORAGE_HEADERS_KEY] as Record<string, string> | undefined;
    if (headers?.Authorization) return headers;
    return null;
  } catch {
    return null;
  }
}

export async function uploadDeepSeekFile(input: DeepSeekFileUploadInput, signal?: AbortSignal): Promise<DeepSeekUploadedFile> {
  if (!input.file.type.startsWith('image/')) {
    throw new DeepSeekPayloadError(`${input.filename} is not an image file.`);
  }
  if (input.file.size > DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES) {
    throw new DeepSeekPayloadError(`${input.filename} exceeds the ${formatBytes(DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES)} image upload limit.`);
  }

  const form = new FormData();
  form.append('file', input.file, input.filename);

  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('uploadFile', {
      credentials: 'include',
      headers: {
        [DEEPSEEK_BYPASS_HOOK_HEADER]: '1',
        ...input.clientHeaders,
        ...input.powHeaders,
        'x-thinking-enabled': '0',
        'x-model-type': normalizeDeepSeekModelType(input.modelType),
        'x-file-size': String(input.file.size),
      },
      body: form,
    }),
    'DeepSeek file upload',
    'upload',
    { signal },
  );

  const json = await readJsonResponse(response, 'DeepSeek file upload', 'payload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const uploaded = normalizeUploadedFile(bizData);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while uploading file: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !uploaded) {
    throw new DeepSeekPayloadError(`Failed to upload DeepSeek file: ${JSON.stringify(data ?? json)}`, { retryable: true });
  }

  return waitForUploadedFileReady(uploaded, input.clientHeaders, signal);
}

async function fetchUploadedFileMetadata(
  fileId: string,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile | null> {
  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('fetchFiles', {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        [DEEPSEEK_BYPASS_HOOK_HEADER]: '1',
        ...clientHeaders,
      },
    }, { searchParams: { file_ids: fileId } }),
    'DeepSeek file metadata',
    'upload',
    { signal },
  );
  const json = await readJsonResponse(response, 'DeepSeek file metadata', 'payload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const files = Array.isArray(bizData?.files) ? bizData.files : [];
  const file = files
    .map((item: unknown) => normalizeUploadedFile(item))
    .find((item: DeepSeekUploadedFile | null): item is DeepSeekUploadedFile => item?.id === fileId);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while fetching file metadata: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0) {
    throw new DeepSeekPayloadError(`Failed to fetch DeepSeek file metadata: ${JSON.stringify(data ?? json)}`, { retryable: true });
  }

  return file ?? null;
}

/**
 * @internal 审计 #43：导出供守卫测试。轮询上传文件状态直到就绪。
 * 两处 signal.aborted 检查确保取消后立即停止（不等 sleep 返回）。
 */
export async function waitForUploadedFileReady(
  uploaded: DeepSeekUploadedFile,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile> {
  assertUploadedFileNotRejected(uploaded);
  if (isUploadedFileReady(uploaded)) return uploaded;
  // 审计 P2-6：原 `if (!uploaded.status) return uploaded;` 会把"缺 status"
  // 的上传结果直接当就绪返回，跳过轮询与审计校验。改为继续轮询直至拿到
  // SUCCESS+审计通过，或到达超时抛出可重试错误。

  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  let latest = uploaded;
  while (Date.now() < deadline) {
    // 审计 #43：循环开头复查 signal，取消后立即停（不只等 sleep 返回）。
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await sleep(FILE_READY_POLL_INTERVAL_MS, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const next = await fetchUploadedFileMetadata(uploaded.id, clientHeaders, signal);
    if (!next) continue;
    latest = next;
    assertUploadedFileNotRejected(latest);
    if (isUploadedFileReady(latest)) return latest;
  }

  throw new DeepSeekPayloadError(
    `DeepSeek file ${uploaded.fileName ?? uploaded.id} is still processing after ${Math.round(FILE_READY_TIMEOUT_MS / 1000)}s.`,
    { retryable: true },
  );
}

export async function submitPrompt(input: SubmitPromptInput, signal?: AbortSignal): Promise<ModelTurn> {
  return submitPromptWithContext(input, { signal });
}

async function submitPromptWithContext(
  input: SubmitPromptInput,
  context: DeepSeekRequestContext,
): Promise<ModelTurn> {
  const response = await requestCompletion(input, context);

  if (!response.ok) {
    throw new DeepSeekPayloadError(await readFailureMessage(response), { retryable: true });
  }

  if (!response.body) {
    throw new DeepSeekPayloadError('DeepSeek completion response did not include a stream body.', { retryable: true });
  }

  return readCompletionStream(response);
}

export async function submitPromptStreaming(
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  const response = await requestCompletion(input, { signal });

  if (!response.ok) {
    throw new DeepSeekPayloadError(await readFailureMessage(response), { retryable: true });
  }

  if (!response.body) {
    throw new DeepSeekPayloadError('DeepSeek completion response did not include a stream body.', { retryable: true });
  }

  const decoratedCallbacks = callbacks.onTokenSpeed
    ? {
      ...callbacks,
      onTokenSpeed(progress: ResponseTokenSpeedPayload) {
        callbacks.onTokenSpeed?.({
          ...progress,
          chatSessionId: input.chatSessionId,
          modelType: progress.modelType ?? input.modelType,
        });
      },
    }
    : callbacks;

  return readCompletionStreamWithCallbacks(response, decoratedCallbacks);
}

async function requestCompletion(
  input: SubmitPromptInput,
  context: DeepSeekRequestContext,
): Promise<Response> {
  // Audit fix #1: web completion must not silently fall back to the 120s
  // request-policy default. Pin a 300s streaming budget when the caller has
  // not supplied an explicit deadline.
  const completionContext: DeepSeekRequestContext = {
    ...context,
    deadlineAt: context.deadlineAt ?? Date.now() + WEB_COMPLETION_STREAM_DEADLINE_MS,
  };
  return requestDeepSeek(
    encodeCompletionRequest(input),
    'DeepSeek completion',
    'completion',
    completionContext,
  );
}

export async function readHistorySnapshot(
  chatSessionId: string,
  expectedAssistantMessageId: number,
  clientHeadersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekHistorySnapshot | null> {
  return readHistorySnapshotWithContext(
    chatSessionId,
    expectedAssistantMessageId,
    clientHeadersOverride,
    { signal },
  );
}

async function readHistorySnapshotWithContext(
  chatSessionId: string,
  expectedAssistantMessageId: number,
  clientHeadersOverride: Record<string, string> | undefined,
  context: DeepSeekRequestContext,
): Promise<DeepSeekHistorySnapshot | null> {
  const clientHeaders = clientHeadersOverride ?? createClientHeaders();
  const response = await requestDeepSeek(
    encodeHistoryRequest(chatSessionId, clientHeaders),
    'DeepSeek history',
    'history',
    context,
  );
  if (!response.ok) {
    await cancelResponseBody(response);
    return null;
  }

  const json = await readJsonResponse(response, 'DeepSeek history', 'payload');
  const data = json?.data?.biz_data ?? json?.data ?? json?.biz_data ?? json;
  const rawMessages: unknown[] = Array.isArray(data?.chat_messages) ? data.chat_messages : [];
  if (rawMessages.length === 0) return null;

  const messages = rawMessages
    .map((message: unknown) => normalizeHistoryMessage(message))
    .filter((message: DeepSeekHistoryMessage): message is DeepSeekHistoryMessage => message.id !== null);
  if (messages.length === 0) return null;

  const expected = messages.find((message) => message.id === expectedAssistantMessageId);
  const latestAssistant =
    expected ??
    [...messages].reverse().find((message) => message.role !== 'user') ??
    messages[messages.length - 1];

  return {
    chatSessionId,
    parentMessageId: latestAssistant.id,
    assistantMessageId: latestAssistant.id,
    messageCount: messages.length,
    verifiedAt: Date.now(),
  };
}

export function normalizeMessageId(value: unknown, fieldName = 'message_id'): number | null {
  const id = normalizeDeepSeekMessageId(value);
  if (id !== null || value === null || value === undefined || value === '') return id;
  throw new DeepSeekPayloadError(`DeepSeek ${fieldName} must be a u32 number, received ${JSON.stringify(value)}.`);
}

export function buildDeepSeekSessionUrl(chatSessionId: string): string {
  return buildDeepSeekWebSessionUrl(chatSessionId);
}

async function readCompletionStream(response: Response): Promise<ModelTurn> {
  return readCompletionStreamWithCallbacks(response, {});
}

async function readCompletionStreamWithCallbacks(
  response: Response,
  callbacks: StreamCallbacks,
): Promise<ModelTurn> {
  const reader = response.body!.getReader();
  const decoder = createDeepSeekSseByteDecoder();
  const summary = createDeepSeekStreamSummary();
  const retainAssistantText = callbacks.retainAssistantText !== false;
  const speedTracker = callbacks.onTokenSpeed
    ? createResponseTokenSpeedTracker((progress) => callbacks.onTokenSpeed?.({
      ...progress,
      assistantMessageId: summary.responseMessageId,
    }), TOKEN_SPEED_EMIT_INTERVAL_MS)
    : null;
  const onParsed = speedTracker
    ? (parsed: unknown, event: SSEEvent) => {
      speedTracker.updateServerStats(extractResponseUsageStatsFromParsed(parsed, event.type));
      const tokenText = extractResponseTextForTokenSpeed(parsed);
      if (tokenText) speedTracker.append(tokenText);
      if (isStreamFinishedFromParsed(parsed)) speedTracker.finish();
    }
    : undefined;

  let streamAbortedMidResponse = false;
  // Audit fix (20261007, issue 1): track whether any visible text delta was
  // produced independently of summary.assistantText. The streaming agent path
  // passes retainAssistantText:false, which deliberately never accumulates
  // summary.assistantText — so the old `summary.assistantText !== ''` check
  // was always false there, causing every mid-response interruption to be
  // upgraded to a fatal error instead of a recoverable partial completion.
  let receivedAnyVisibleChunk = false;

  // R05: 流式心跳——30s 无 SSE 帧记一次 stream_stall（只可见化、不断开，避免误杀长思考）。
  // 10s 轮询一次；同一停滞只记一次，恢复到帧后重新计。finally 清理定时器。
  const STALL_WARN_MS = 30_000;
  const STALL_POLL_MS = 10_000;
  let lastFrameAt = Date.now();
  let lastStallLoggedAt = 0;
  // 审计 P2-8：retainAssistantText:false 时 summary.assistantText 永不累积，
  // stall 日志里 text_len 恒为 0。本地累计可见文本长度，供停滞诊断使用。
  let visibleTextLen = 0;
  const stallTimer = setInterval(() => {
    const now = Date.now();
    const decision = evaluateStreamStall(now, lastFrameAt, lastStallLoggedAt, STALL_WARN_MS);
    if (decision.stalled) {
      lastStallLoggedAt = decision.nextLoggedAt;
      diagnosticLogBuffer.record({
        level: 'warn',
        source: 'stream',
        message: 'stream_stall',
        details: `no_frame_ms=${now - lastFrameAt} text_len=${visibleTextLen}`,
      });
    }
  }, STALL_POLL_MS);

  try {
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (readerErr) {
        // Stream was interrupted mid-response (timeout abort, connection reset).
        // If we already consumed some displayable content — partial text or
        // reasoning — return the partial summary so the caller can continue
        // instead of treating this as a fatal error.
        // Audit fix S-2: do NOT count responseMessageId alone as partial content —
        // it is set far earlier than any text (on the first id frame), so a
        // "connected then immediately dropped" connection would be silently
        // downgraded to a successful empty result. Only actual displayable
        // content qualifies for the partial-content downgrade.
        // If we got nothing displayable at all, the error propagates up unchanged.
        // 20261007 fix: use receivedAnyVisibleChunk (tracked from onTextChunk
        // deltas) instead of summary.assistantText, which is never accumulated
        // when retainAssistantText:false.
        // T1-1: a model may declare an output fragment (a TOOL fragment opening
        // with no text/thinking delta yet) before the connection resets or the
        // step timeout fires. Declared fragments prove the server started a
        // response, so this interruption is a recoverable partial turn rather
        // than a fatal error. The ready/id frame alone still does NOT qualify
        // (see S-2 note above) — only a declared output fragment does.
        const hasPartialContent = receivedAnyVisibleChunk
          || summary.assistantReasoningText !== ''
          || getDeepSeekFragmentState(summary).fragmentTypes.length > 0;
        if (hasPartialContent) {
          streamAbortedMidResponse = true;
          break;
        }
        throw readerErr;
      }
      if (done) break;
      lastFrameAt = Date.now();

      const newText = consumeDeepSeekSseEvents(decoder.push(value!), summary, {
        retainAssistantText,
        onParsed,
        onReasoningChunk: callbacks.onReasoningChunk,
      });
      if (newText) {
        receivedAnyVisibleChunk = true;
        visibleTextLen += newText.length;
        callbacks.onTextChunk?.(newText, summary.assistantText);
      }
    }

    const finalText = consumeDeepSeekSseEvents(decoder.finish(), summary, {
      retainAssistantText,
      onParsed,
      onReasoningChunk: callbacks.onReasoningChunk,
    });
    if (finalText) {
      receivedAnyVisibleChunk = true;
      visibleTextLen += finalText.length;
      callbacks.onTextChunk?.(finalText, summary.assistantText);
    }
    // Audit fix Q-2: the byte stream ended (done===true) but the server never
    // sent an explicit "finished" frame — this is a suspicious truncation, not
    // a clean completion. Log it so it is visible in diagnostics instead of
    // being silently treated as normal.
    if (!summary.finished && !streamAbortedMidResponse) {
      console.warn('[DPP-stream] byte stream ended without explicit finished frame (suspicious truncation)', {
        assistantTextLength: summary.assistantText.length,
        responseMessageId: summary.responseMessageId,
      });
      diagnosticLogBuffer.record({
        level: 'warn',
        source: 'deepseek-stream',
        message: 'suspicious_truncation',
        details: `len=${summary.assistantText.length} msg=${summary.responseMessageId ?? 'n/a'}`,
      });
    }
  } finally {
    clearInterval(stallTimer);
    speedTracker?.finish();
    if (streamAbortedMidResponse) {
      try { await reader.cancel(); } catch { /* ignore cleanup errors */ }
    }
  }

  // Audit fix S-1: finalize summary.finished BEFORE calling onFinished, so
  // downstream consumers that make decisions inside onFinished can distinguish
  // "truncated" (finished=false) from "normal completion" (finished=true).
  // Previously onFinished was called unconditionally and finished=false was
  // set afterwards — invisible to any onFinished handler.
  if (streamAbortedMidResponse) {
    summary.finished = false;
  }
  callbacks.onFinished?.();
  return summary;
}

function normalizeHistoryMessage(raw: unknown): DeepSeekHistoryMessage {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    id: firstMessageId(value.message_id, value.id, value.uuid),
    parentId: firstMessageId(value.parent_id, value.parent_message_id, value.parentMessageId),
    role: firstString(value.message_role, value.role)?.toLowerCase() ?? null,
  };
}

function readDeepSeekUserToken(): string | null {
  // 审计 P2-2：MV3 service worker 全局没有 localStorage，直接访问会抛
  // ReferenceError。显式 typeof 守卫，SW 上下文直接返回 null（token 走
  // chrome.storage 的 loadClientHeadersFromStorage 路径），不再依赖 try/catch
  // 兜底吞错。
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (!raw) return null;

    const parsed = tryParseJson(raw);
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (parsed && typeof parsed === 'object') {
      return firstString(
        (parsed as Record<string, unknown>).token,
        (parsed as Record<string, unknown>).value,
        (parsed as Record<string, unknown>).accessToken,
      );
    }

    if (raw.trim() === 'null') return null;
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function normalizeHeaders(headersInit: HeadersInit | undefined): Headers | null {
  if (!headersInit) return null;
  try {
    return new Headers(headersInit);
  } catch {
    return null;
  }
}

function getDeepSeekAppVersion(): string {
  return DEFAULT_APP_VERSION;
}

function getDeepSeekLocale(): string {
  // MV3 service worker 全局无 document，自动化/扩写路径在此实例化客户端时
  // 会抛 ReferenceError。无 document 时退回 navigator.language。
  if (typeof document !== 'undefined' && document.documentElement?.lang) {
    return document.documentElement.lang;
  }
  return navigator.language || 'en-US';
}

async function createPowChallenge(
  clientHeaders: Record<string, string>,
  targetPath: string,
  context: DeepSeekRequestContext,
): Promise<PowChallenge> {
  const response = await requestDeepSeek(
    encodePowChallengeRequest(clientHeaders, targetPath),
    'DeepSeek PoW challenge',
    'pow',
    context,
  );
  // HTTP 401/403 means the token itself is rejected; classify as auth so the
  // caller refreshes credentials instead of treating it as a PoW failure and
  // retry-storming (401/403 PoW misclassification).
  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekAuthError(
      `DeepSeek auth token was rejected (HTTP ${response.status}) while creating PoW challenge.`,
    );
  }
  const json = await readJsonResponse(response, 'DeepSeek PoW challenge', 'pow');
  const data = json?.data;
  const challenge = data?.biz_data?.challenge;

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !challenge) {
    throw new DeepSeekPowError(`Failed to create DeepSeek PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  return {
    algorithm: String(challenge.algorithm),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt),
    difficulty: Number(challenge.difficulty),
    signature: String(challenge.signature),
    expireAt: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
    expireAfter: Number(challenge.expire_after ?? challenge.expireAfter ?? 0),
  };
}

function normalizeUploadedFile(raw: unknown): DeepSeekUploadedFile | null {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const id = firstString(value.id, value.file_id, value.fileId);
  if (!id) return null;

  return {
    id,
    fileName: firstString(value.file_name, value.fileName, value.name),
    fileSize: firstFiniteNumber(value.file_size, value.fileSize, value.size),
    mimeType: firstString(value.mime_type, value.mimeType),
    status: firstString(value.status),
    signedPath: firstString(value.signed_path, value.signedPath),
    auditResult: firstString(value.audit_result, value.auditResult),
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
    width: firstFiniteNumber(value.width),
    height: firstFiniteNumber(value.height),
  };
}

function isUploadedFileReady(file: DeepSeekUploadedFile): boolean {
  const status = file.status?.toUpperCase();
  return status === 'SUCCESS' && isUploadedFileAuditAccepted(file);
}

function assertUploadedFileNotRejected(file: DeepSeekUploadedFile): void {
  const status = file.status?.toUpperCase();
  if (isUploadedFileAuditRejected(file)) {
    throw new DeepSeekPayloadError(`DeepSeek rejected ${file.fileName ?? file.id}: audit_result=${file.auditResult}.`);
  }
  if (status === 'FAILED' || status === 'FAIL' || status === 'ERROR') {
    throw new DeepSeekPayloadError(`DeepSeek failed to process ${file.fileName ?? file.id}: status=${file.status}.`, {
      retryable: file.retryable ?? false,
    });
  }
}

function normalizeFileAuditResult(file: DeepSeekUploadedFile): string | null {
  const auditResult = file.auditResult?.trim();
  return auditResult ? auditResult.toUpperCase() : null;
}

function isUploadedFileAuditAccepted(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return !auditResult || ACCEPTED_FILE_AUDIT_RESULTS.has(auditResult);
}

function isUploadedFileAuditRejected(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return auditResult ? REJECTED_FILE_AUDIT_RESULTS.has(auditResult) : false;
}

async function solvePowChallenge(
  challenge: PowChallenge,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<PowAnswer> {
  try {
    return await solvePowChallengeLocally(challenge, wasmUrl, signal);
  } catch (err) {
    throwIfPowAborted(signal);
    const localMessage = err instanceof Error ? err.message : String(err);
    throw new DeepSeekPowError(`DeepSeek PoW challenge failed: ${localMessage}`);
  }
}

function isAuthBizError(data: any, json: any): boolean {
  return data?.biz_code === 40002 || data?.biz_code === 40003 || json?.code === 40002 || json?.code === 40003;
}

async function readFailureMessage(response: Response): Promise<string> {
  const text = await readNetworkResponseText(response, 'DeepSeek completion');
  return text || `DeepSeek completion failed with HTTP ${response.status}.`;
}

type DeepSeekJsonErrorKind = 'payload' | 'pow' | 'session';

async function readJsonResponse(
  response: Response,
  label: string,
  errorKind: DeepSeekJsonErrorKind,
): Promise<any> {
  const text = await readNetworkResponseText(response, label);
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    const message = `${label} returned non-JSON HTTP ${response.status}: ${preview || response.statusText}`;
    if (errorKind === 'pow') throw new DeepSeekPowError(message);
    if (errorKind === 'session') throw new DeepSeekSessionError(message);
    throw new DeepSeekPayloadError(message, { retryable: response.status === 429 || response.status >= 500 });
  }
}

async function requestDeepSeek(
  request: { url: string; init: RequestInit },
  operation: string,
  phase: 'session' | 'pow' | 'completion' | 'history' | 'upload',
  context: DeepSeekRequestContext,
): Promise<Response> {
  return fetchWithNetworkPolicy(request.url, {
    ...request.init,
    signal: context.signal,
  }, {
    operation,
    phase,
    deadlineAt: context.deadlineAt,
    maxRequestBytes: DEEPSEEK_BODY_BUDGETS.activeRequest,
    maxResponseBytes: phase === 'completion'
      ? DEEPSEEK_BODY_BUDGETS.activeCompletion
      : DEEPSEEK_BODY_BUDGETS.activeJson,
    fetchImpl: context.fetchImpl,
    onDispatch: context.onDispatch,
  });
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstMessageId(...values: unknown[]): number | null {
  for (const value of values) {
    const id = normalizeDeepSeekMessageId(value);
    if (id !== null) return id;
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * T4-5: compute a retry delay honoring a numeric Retry-After (seconds) header,
 * falling back to the caller's exponential backoff and adding small jitter so
 * concurrent clients do not thundering-herd the same recovery window.
 */
function retryDelayMs(response: Response, fallbackMs: number): number {
  const raw = response.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30_000) + Math.floor(Math.random() * 250);
    }
  }
  return fallbackMs + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
