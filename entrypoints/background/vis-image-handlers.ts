/**
 * vis 卡片的远程图片通路：后台抓图 → data URL。
 *
 * **不做运行时授权**（与 dpp 现状一致：它没有"授权"概念）。
 * host 权限在 manifest 里一次性声明 http(s)://*\/*，因此这里可以直连任意图床；
 * content script 侧受 CORS 与防盗链限制拿不到字节，所以必须借后台。
 *
 * 安全约束：只接受 http(s)、只收 image/*、上限 2MB、8 秒超时。
 */
import { originPatternOf } from '../../core/vis/remote-image';

export const VIS_IMAGE_FETCH = 'VIS_IMAGE_FETCH';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

function toDataUrl(bytes: ArrayBuffer, contentType: string): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

export async function fetchImageAsDataUrl(rawUrl: string): Promise<{ dataUrl: string | null; reason?: string }> {
  if (!originPatternOf(rawUrl)) return { dataUrl: null, reason: 'unsupported_url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // no-referrer：不少图床按 Referer 判防盗链（豆瓣 418 就是带了外来 Referer）
    const response = await fetch(rawUrl, {
      signal: controller.signal,
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    if (!response.ok) return { dataUrl: null, reason: `http_${response.status}` };
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return { dataUrl: null, reason: 'not_an_image' };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return { dataUrl: null, reason: 'empty_body' };
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { dataUrl: null, reason: 'too_large' };
    return { dataUrl: toDataUrl(bytes, contentType) };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { dataUrl: null, reason: aborted ? 'timeout' : 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

export function registerVisImageMessageHandlers(): void {
  const flag = '__dppVisImageHandlersRegistered';
  const holder = globalThis as Record<string, unknown>;
  if (holder[flag]) return;
  holder[flag] = true;

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if ((message as { type?: unknown }).type !== VIS_IMAGE_FETCH) return false;
    const url = (message as { url?: unknown }).url;
    void fetchImageAsDataUrl(typeof url === 'string' ? url : '').then((result) => sendResponse(result));
    return true;
  });
}
