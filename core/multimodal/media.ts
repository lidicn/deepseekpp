import type { ToolResult } from '../tool/types';

export type MultimodalMediaKind = 'image' | 'video';

export const MULTIMODAL_MEDIA_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MULTIMODAL_MEDIA_VIDEO_INLINE_MAX_BYTES = 20 * 1024 * 1024;
export const MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN = 8;
export const MULTIMODAL_MEDIA_PREFLIGHT_PROMPT_START = '[DeepSeek++ automatic multimodal MCP analysis]';
export const MULTIMODAL_MEDIA_PREFLIGHT_PROMPT_END = '[/DeepSeek++ automatic multimodal MCP analysis]';

/** URL 图片下载限制 */
export const URL_IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const URL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const URL_IMAGE_ALLOWED_MIME_PREFIXES = ['image/'];

export interface MultimodalMediaInput {
  id: string;
  kind: MultimodalMediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl?: string;
  base64Data?: string;
  url?: string;
}

export interface MultimodalMediaAnalysisSubject {
  id: string;
  kind: MultimodalMediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MultimodalMediaAnalyzeRequest {
  prompt: string;
  media: MultimodalMediaInput[];
  chatSessionId?: string | null;
  parentMessageId?: number | null;
}

export interface MultimodalMediaAnalysisItem {
  id: string;
  kind: MultimodalMediaKind;
  media: MultimodalMediaAnalysisSubject[];
  result: ToolResult;
}

export interface MultimodalMediaAnalyzeResponse {
  ok: boolean;
  analyses: MultimodalMediaAnalysisItem[];
  error?: string;
}

export interface MultimodalPendingRouteItem {
  id: string;
  routeKey: string;
  createdAt: number;
}

export interface MultimodalMediaRouteRequest {
  parentMessageId?: number | string | null;
}

export async function normalizeMultimodalMediaAnalyzeRequest(
  value: unknown,
): Promise<MultimodalMediaAnalyzeRequest> {
  const request = recordValue(value, 'ANALYZE_MULTIMODAL_MEDIA.payload');
  const prompt = typeof request.prompt === 'string' && request.prompt.trim()
    ? request.prompt.trim()
    : 'Analyze the attached media.';
  const media = await normalizeMultimodalMediaInputs(request.media);

  const chatSessionId = optionalNullableString(
    request.chatSessionId,
    'ANALYZE_MULTIMODAL_MEDIA.payload.chatSessionId',
  );
  const parentMessageId = optionalNullableMessageId(
    request.parentMessageId,
    'ANALYZE_MULTIMODAL_MEDIA.payload.parentMessageId',
  );

  return {
    prompt,
    media,
    ...(chatSessionId === undefined ? {} : { chatSessionId }),
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
  };
}

export function assertSupportedMultimodalMedia(
  input: Pick<MultimodalMediaInput, 'kind' | 'mimeType' | 'sizeBytes' | 'name'>,
): void {
  if (input.kind === 'image') {
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`${input.name} is not an image file.`);
    }
    if (input.sizeBytes > MULTIMODAL_MEDIA_IMAGE_MAX_BYTES) {
      throw new Error(
        `${input.name} is larger than the ${formatLimit(MULTIMODAL_MEDIA_IMAGE_MAX_BYTES)} image limit.`,
      );
    }
    return;
  }

  if (!input.mimeType.startsWith('video/')) {
    throw new Error(`${input.name} is not a video file.`);
  }
  if (input.sizeBytes > MULTIMODAL_MEDIA_VIDEO_INLINE_MAX_BYTES) {
    throw new Error(
      `${input.name} is larger than the ${formatLimit(MULTIMODAL_MEDIA_VIDEO_INLINE_MAX_BYTES)} inline video limit. Use a public video URL or a future local-path picker for large videos.`,
    );
  }
}

async function normalizeMultimodalMediaInputs(value: unknown): Promise<MultimodalMediaInput[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('No multimodal media was provided.');
  }
  if (value.length > MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN) {
    throw new Error(`Attach at most ${MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN} media files per turn.`);
  }

  const normalized: MultimodalMediaInput[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`media[${index}] must be provided.`);
    }
    const item = value[index];
    const input = recordValue(item, `media[${index}]`);
    const kind = input.kind;
    if (kind !== 'image' && kind !== 'video') {
      throw new Error(`media[${index}].kind must be image or video.`);
    }
    const normalizedItem: MultimodalMediaInput = {
      id: nonEmptyString(input.id, `media[${index}].id`),
      kind,
      name: nonEmptyString(input.name, `media[${index}].name`),
      mimeType: nonEmptyString(input.mimeType, `media[${index}].mimeType`),
      sizeBytes: finiteNonNegativeNumber(input.sizeBytes, `media[${index}].sizeBytes`),
      dataUrl: typeof input.dataUrl === 'string' && input.dataUrl ? input.dataUrl : undefined,
      base64Data: typeof input.base64Data === 'string' && input.base64Data
        ? input.base64Data
        : undefined,
      url: typeof input.url === 'string' && input.url ? input.url : undefined,
    };

    // M-URL 修复：如果只有 URL 没有 dataUrl，自动下载并转成 base64
    if (kind === 'image' && !normalizedItem.dataUrl && normalizedItem.url) {
      try {
        const downloaded = await downloadImageAsDataUrl(normalizedItem.url);
        normalizedItem.dataUrl = downloaded.dataUrl;
        normalizedItem.mimeType = downloaded.mimeType;
        normalizedItem.sizeBytes = downloaded.sizeBytes;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to download image from URL (${normalizedItem.url.substring(0, 60)}): ${reason}`);
      }
    }

    assertSupportedMultimodalMedia(normalizedItem);
    assertMultimodalMediaBody(normalizedItem);
    normalized.push(normalizedItem);
  }
  return normalized;
}

function assertMultimodalMediaBody(input: MultimodalMediaInput): void {
  if (input.kind === 'image') {
    if (!input.dataUrl) throw new Error(`${input.name} is missing image data.`);
    const separator = input.dataUrl.indexOf(',');
    const header = separator >= 0 ? input.dataUrl.slice(0, separator) : '';
    const headerMatch = /^data:([^;,]+);base64$/.exec(header);
    if (!headerMatch) throw new Error(`${input.name} image data must be a base64 data URL.`);
    if (headerMatch[1] !== input.mimeType) {
      throw new Error(`Image MIME type changed from ${input.mimeType} to ${headerMatch[1]}.`);
    }
    assertBase64Size(input.dataUrl.slice(separator + 1), input.sizeBytes, input.name);
    return;
  }

  if (!input.base64Data) throw new Error(`${input.name} is missing video data.`);
  assertBase64Size(input.base64Data, input.sizeBytes, input.name);
}

function assertBase64Size(value: string, expectedBytes: number, name: string): void {
  const expectedEncodedLength = Math.ceil(expectedBytes / 3) * 4;
  if (value.length !== expectedEncodedLength) {
    throw new Error(`${name} payload size changed during transfer.`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${name} contains invalid base64 data.`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const actualBytes = (value.length / 4) * 3 - padding;
  if (actualBytes !== expectedBytes) {
    throw new Error(`${name} payload size changed during transfer.`);
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function finiteNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return value;
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null.`);
  return value;
}

function optionalNullableMessageId(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer or null.`);
  }
  return value as number;
}

export function buildMultimodalAnalysisPrompt(
  userPrompt: string,
  analyses: readonly MultimodalMediaAnalysisItem[],
): string {
  if (analyses.length === 0) return userPrompt;

  const mediaText = analyses.map((item, index) => {
    const text = toolResultText(item.result);
    const subjects = item.media.map((media) =>
      `- ${media.name} (${media.mimeType}, ${media.sizeBytes} bytes)`,
    ).join('\n');
    return [
      `Media analysis ${index + 1}: ${item.kind}`,
      subjects,
      text,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    MULTIMODAL_MEDIA_PREFLIGHT_PROMPT_START,
    mediaText,
    MULTIMODAL_MEDIA_PREFLIGHT_PROMPT_END,
    '',
    userPrompt,
  ].join('\n');
}

export function hasDeepSeekChatSessionRoute(routeKey: string): boolean {
  const pathname = routeKey.split('?')[0] ?? routeKey;
  return /\/(?:a\/)?chat\/s\/[^/?#]+/.test(pathname);
}

export function shouldPreserveInitialMultimodalMediaRoute(
  previousRouteKey: string,
  nextRouteKey: string,
): boolean {
  return previousRouteKey !== nextRouteKey &&
    !hasDeepSeekChatSessionRoute(previousRouteKey) &&
    hasDeepSeekChatSessionRoute(nextRouteKey);
}

export function selectMultimodalMediaRouteKeyForRequest(
  pending: readonly MultimodalPendingRouteItem[],
  currentRouteKey: string,
  request: MultimodalMediaRouteRequest,
): string | null {
  if (pending.some((item) => item.routeKey === currentRouteKey)) return currentRouteKey;
  if (!isInitialMultimodalRequest(request)) return null;

  let selected: MultimodalPendingRouteItem | null = null;
  for (const item of pending) {
    if (hasDeepSeekChatSessionRoute(item.routeKey)) continue;
    if (!selected || item.createdAt > selected.createdAt) selected = item;
  }
  return selected?.routeKey ?? null;
}

function isInitialMultimodalRequest(request: MultimodalMediaRouteRequest): boolean {
  return request.parentMessageId == null;
}

function toolResultText(result: ToolResult): string {
  const outputText = extractOutputText(result.output);
  if (outputText) return outputText;
  return result.detail || result.summary;
}

function extractOutputText(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const text = (output as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
}

function formatLimit(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

/**
 * M-URL 修复：从 http/https URL 下载图片并转成 base64 data URL。
 * 用于工具返回 URL 图片时，自动物化为模型可识别的 image block。
 *
 * 安全限制：
 * - 超时 10 秒
 * - 大小上限 2MB
 * - 仅允许 image/* MIME 类型
 * - 仅支持 http/https 协议
 */
export async function downloadImageAsDataUrl(
  url: string,
): Promise<{ dataUrl: string; mimeType: string; sizeBytes: number }> {
  // 协议白名单
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Only http/https URLs are supported, got: ${url.substring(0, 50)}`);
  }

  // 带超时的 fetch
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), URL_IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.substring(0, 80)}`);
    }

    // 检查 MIME 类型
    const contentType = response.headers.get('content-type') ?? '';
    const mimeType = contentType.split(';')[0]?.trim() ?? '';
    const allowed = URL_IMAGE_ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
    if (!allowed) {
      throw new Error(`Unsupported image MIME type: ${mimeType} (only image/* allowed)`);
    }

    // 读取字节并检查大小
    const arrayBuffer = await response.arrayBuffer();
    const sizeBytes = arrayBuffer.byteLength;
    if (sizeBytes > URL_IMAGE_MAX_BYTES) {
      throw new Error(
        `Image is ${formatLimit(sizeBytes)}, exceeds URL image limit of ${formatLimit(URL_IMAGE_MAX_BYTES)}`,
      );
    }
    if (sizeBytes === 0) {
      throw new Error(`Image download returned 0 bytes`);
    }

    // 转成 base64 data URL
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return { dataUrl, mimeType, sizeBytes };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Image download timed out after ${URL_IMAGE_DOWNLOAD_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * M-URL 修复：从工具结果文本中扫描图片 URL。
 * 支持检测：
 * - JSON 字段："url": "http://..." / "image_url": "http://..."
 * - Markdown 图片：![](http://...)
 * - 纯文本中的图片 URL（带 .png/.jpg/.jpeg/.gif/.webp/.bmp/.svg 扩展名）
 */
export interface ScannedImageUrl {
  url: string;
  source: 'json-field' | 'markdown' | 'text-extension';
  context?: string;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

export function scanImageUrlsFromText(text: string): ScannedImageUrl[] {
  if (!text || typeof text !== 'string') return [];

  const results: ScannedImageUrl[] = [];
  const seen = new Set<string>();

  // 1. JSON 字段："url" 或 "image_url"
  const jsonFieldRegex = /["'](?:url|image_url)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonFieldRegex.exec(text)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, source: 'json-field' });
    }
  }

  // 2. Markdown 图片：![](url)
  const markdownRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  while ((match = markdownRegex.exec(text)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, source: 'markdown' });
    }
  }

  // 3. 纯文本中的图片 URL（带图片扩展名）
  const textUrlRegex = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg))(?:\?[^\s"'<>]*)?/gi;
  while ((match = textUrlRegex.exec(text)) !== null) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, source: 'text-extension' });
    }
  }

  return results;
}

/**
 * M-URL 修复：从工具执行记录中扫描并下载所有图片 URL，
 * 返回 URL -> base64 data URL 的映射。
 * 失败的 URL 会被跳过，不阻断主流程。
 */
export async function materializeImageUrlsFromToolResult(
  resultText: string,
): Promise<Map<string, { dataUrl: string; mimeType: string; sizeBytes: number }>> {
  const scanned = scanImageUrlsFromText(resultText);
  const mapping = new Map<string, { dataUrl: string; mimeType: string; sizeBytes: number }>();

  for (const item of scanned) {
    try {
      const downloaded = await downloadImageAsDataUrl(item.url);
      mapping.set(item.url, downloaded);
    } catch {
      // 下载失败的 URL 跳过，不阻断主流程
      // 模型仍会看到原 URL 文本
    }
  }

  return mapping;
}
