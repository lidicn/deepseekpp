import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { createAbortScope } from '../network/abort';
import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from './types';

export const WEB_SEARCH_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'web',
  displayName: translate(DEFAULT_LOCALE, 'tool.web.providerName'),
  transport: 'in_process',
};

export const WEB_SEARCH_TOOL_NAMES = ['web_search', 'web_fetch'] as const;

/**
 * web_fetch / web_search 单次响应体的字节上限（审计 #14）。
 *
 * 取 1 MiB：远超正常 HTML/JSON 页面所需，又能挡住「返回 500MB 撑爆 SW」这类攻击。
 * 注意这与结果里 50_000 字符的**展示截断**是两回事 —— 那是给模型看的，这是给内存的。
 */
const WEB_FETCH_MAX_RESPONSE_BYTES = 1024 * 1024;

export type WebSearchToolName = typeof WEB_SEARCH_TOOL_NAMES[number];

// #58: 结构化错误 —— 替换原字符串匹配分类（lastError.includes('Failed to fetch') 等）。
// 原实现脆弱：NetworkError 是 Error.name 不是 .message，永远匹配不到；
// 改动后每个 throw 带明确 code，catch 时按 code 分类。
class WebToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebToolError';
    this.code = code;
  }
}

const WEB_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: 'permission_denied',
  HTTP_STATUS: 'http_status',
  BODY_UNREADABLE: 'body_unreadable',
  EMPTY_RESPONSE: 'empty_response',
  NO_PARSEABLE_RESULTS: 'no_parseable_results',
  RESPONSE_TOO_LARGE: 'response_too_large',
  UNSUPPORTED_REDIRECT: 'unsupported_redirect',
  HTTPS_TO_HTTP: 'https_to_http',
} as const);

type WebErrorCode = typeof WEB_ERROR_CODES[keyof typeof WEB_ERROR_CODES];

/** 从任意 catch 到的 error 中提取结构化 code，识别原生 fetch TypeError。 */
function extractWebErrorCode(error: unknown): string | undefined {
  if (error instanceof WebToolError) return error.code;
  if (error instanceof Error) {
    // 原生 fetch 抛 TypeError "Failed to fetch" 时通常是 host permission 拒绝
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      return WEB_ERROR_CODES.PERMISSION_DENIED;
    }
  }
  return undefined;
}

export function createWebSearchToolProviderIdentity(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolProviderIdentity {
  return {
    ...WEB_SEARCH_TOOL_PROVIDER,
    displayName: translate(locale, 'tool.web.providerName'),
  };
}

export function createWebSearchToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor[] {
  const provider = createWebSearchToolProviderIdentity(locale);
  return [{
    id: 'local:web:web_search',
    provider,
    name: 'web_search',
    invocationName: 'web_search',
    title: translate(locale, 'tool.web.searchTitle'),
    description: translate(locale, 'tool.web.searchDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: translate(locale, 'tool.web.queryDescription') },
        topK: { type: 'integer', description: translate(locale, 'tool.web.topKDescription') },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
      // T3-2: declare a byte ceiling so downstream governance/history can bound
      // the result; web_search returns at most topK compact snippets.
      maxResultBytes: 32_000,
    },
  },
  {
    id: 'local:web:web_fetch',
    provider,
    name: 'web_fetch',
    invocationName: 'web_fetch',
    title: translate(locale, 'tool.web.fetchTitle'),
    description: translate(locale, 'tool.web.fetchDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: translate(locale, 'tool.web.urlDescription') },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execution: {
      // web_fetch's consent mechanism is the host-permission banner (one-click
      // grant + retry); the scheme whitelist in performWebFetch bounds what it
      // can reach.
      mode: 'auto',
      enabled: true,
      risk: 'medium',
      // T3-2: web_fetch snapshots can reach ~50k chars; declare a ceiling so the
      // generic governance layer and history persistence do not store unbounded
      // output.
      maxResultBytes: 32_000,
    },
  },
  ];
}

export const WEB_SEARCH_TOOL_DESCRIPTORS: ToolDescriptor[] = createWebSearchToolDescriptors(DEFAULT_LOCALE);

export function isWebSearchToolName(name: string): name is WebSearchToolName {
  return (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeWebSearchToolCall(
  call: ToolCall,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: { signal?: AbortSignal },
): Promise<ToolResult> {
  switch (call.name) {
    case 'web_search':
      return performWebSearch(call, locale, options?.signal);
    case 'web_fetch':
      return performWebFetch(call, locale, options?.signal);
    default:
      return {
        ok: false,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.unsupported'),
        error: {
          code: 'web_tool_unsupported',
          message: `Unsupported web tool: ${call.name}`,
          retryable: false,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Web Search via Bing without requiring an API key.
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function performWebSearch(
  call: ToolCall,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const query = typeof call.payload.query === 'string' ? call.payload.query.trim() : '';
  if (!query) {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.emptyQuery'),
      error: { code: 'empty_query', message: 'query is required', retryable: false },
    };
  }

  const topK = typeof call.payload.topK === 'number'
    ? Math.min(Math.max(1, Math.floor(call.payload.topK)), 10)
    : 5;

  // Try multiple Bing domains as fallback.
  // Each domain times out in 8s; total stays under 20s.
  const domains = ['cn.bing.com', 'www.bing.com'];
  let lastErrorMessage: string | null = null;
  let lastErrorCode: string | undefined;
  const startTime = Date.now();

  for (let i = 0; i < domains.length; i++) {
    throwIfWebToolAborted(signal);
    // Guard: if we've been searching for >18s, give up
    if (Date.now() - startTime > 18_000) {
      lastErrorMessage = lastErrorMessage || 'Search timed out (>18s)';
      break;
    }
    try {
      const results = await bingSearch(domains[i], query, topK, locale, signal);
      if (results.length === 0) {
        lastErrorMessage = `${domains[i]} returned no parseable search results`;
        lastErrorCode = WEB_ERROR_CODES.NO_PARSEABLE_RESULTS;
        continue;
      }
      return {
        ok: true,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.searchComplete', { count: results.length }),
        output: results as unknown as JsonValue,
        detail: results
          .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
          .join('\n'),
      };
    } catch (error) {
      throwIfWebToolAborted(signal);
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      lastErrorCode = extractWebErrorCode(error);
      // #58: permission_denied 不重试 —— 用户需要授权 host permission
      if (lastErrorCode === WEB_ERROR_CODES.PERMISSION_DENIED) break;
      // On other errors try the next domain
    }
  }

  // #58: 结构化分类 —— 替换原字符串匹配
  const isPermissionError = lastErrorCode === WEB_ERROR_CODES.PERMISSION_DENIED;
  const hasNoParseableResults = lastErrorCode === WEB_ERROR_CODES.NO_PARSEABLE_RESULTS;

  return {
    ok: false,
    name: call.name,
    provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
    summary: hasNoParseableResults
      ? translate(locale, 'tool.web.searchNoResults')
      : translate(locale, 'tool.web.searchFailed'),
    detail: isPermissionError
      ? translate(locale, 'tool.web.permissionDenied')
      : hasNoParseableResults
        ? translate(locale, 'tool.web.noParseableResults', { error: lastErrorMessage ?? 'unknown error' })
        : translate(locale, 'tool.web.searchFailedDetail', { error: lastErrorMessage ?? 'unknown error' }),
    error: {
      code: isPermissionError
        ? 'search_permission_denied'
        : hasNoParseableResults
          ? 'search_no_results'
          : 'search_failed',
      message: lastErrorMessage ?? 'unknown error',
      retryable: !isPermissionError,
    },
  };
}

async function bingSearch(
  domain: string,
  query: string,
  topK: number,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  let url: URL;
  try {
    url = new URL(`https://${domain}/search`);
    url.searchParams.set('q', query);
  } catch {
    throw new Error(`Invalid search domain: ${domain}`);
  }

  const abortScope = createAbortScope(signal, 8_000);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': locale === 'en' ? 'en-US,en;q=0.9,zh-CN;q=0.6' : 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: abortScope.signal,
    });

    if (!response.ok) {
      if (response.status === 0) {
        throw new WebToolError(WEB_ERROR_CODES.PERMISSION_DENIED, `Host permission denied (opaque response) for ${domain}`);
      }
      throw new WebToolError(WEB_ERROR_CODES.HTTP_STATUS, `${domain} returned status ${response.status}`);
    }

    let html: string;
    try {
      html = await response.text();
    } catch {
      throwIfWebToolAborted(signal);
      throw new WebToolError(WEB_ERROR_CODES.BODY_UNREADABLE, `${domain} response body unreadable`);
    }
    if (html.length < 200) {
      throw new WebToolError(WEB_ERROR_CODES.EMPTY_RESPONSE, `${domain} returned an empty or blocked response (${html.length} bytes)`);
    }
    return parseBingResults(html, topK);
  } finally {
    abortScope.cleanup();
  }
}

function parseBingResults(html: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Bing search results structure:
  // <li class="b_algo">
  //   <h2><a href="URL">Title</a></h2>
  //   <div class="b_caption"><p>Snippet...</p></div>
  // </li>
  const algoRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;

  let match: RegExpExecArray | null;
  while ((match = algoRegex.exec(html)) !== null && results.length < topK) {
    const block = match[1];

    // Extract title link: <h2><a href="URL">Title</a></h2>
    const titleLink = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
    if (!titleLink) continue;

    let url = titleLink[1];
    const title = stripHtml(titleLink[2]).replace(/\s+/g, ' ').trim();

    // Extract snippet from b_caption
    const captionBlock = /<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    let snippet = '';
    if (captionBlock) {
      // Try <p> inside caption first, otherwise full caption text
      const paraText = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(captionBlock[1]);
      snippet = paraText
        ? stripHtml(paraText[1]).replace(/\s+/g, ' ').trim()
        : stripHtml(captionBlock[1]).replace(/\s+/g, ' ').trim();
    }

    // Bing results sometimes have protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url;

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Web Fetch: download a URL and extract visible text
// ---------------------------------------------------------------------------

async function performWebFetch(
  call: ToolCall,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const url = typeof call.payload.url === 'string' ? call.payload.url.trim() : '';
  if (!url) {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.emptyUrl'),
      error: { code: 'empty_url', message: 'url is required', retryable: false },
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.invalidUrl'),
      detail: translate(locale, 'tool.web.invalidUrlDetail', { url }),
      error: { code: 'invalid_url', message: `Invalid URL: ${url}`, retryable: false },
    };
  }

  // Scheme whitelist: only http/https may be fetched. file:, data:, and other
  // schemes bypass the host-permission/CORS model entirely (H7) and must not
  // be reachable through web_fetch.
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.invalidUrl'),
      detail: translate(locale, 'tool.web.invalidUrlDetail', { url }),
      error: {
        code: 'unsupported_url_scheme',
        message: `Unsupported URL scheme: ${parsedUrl.protocol}`,
        retryable: false,
      },
    };
  }

  try {
    throwIfWebToolAborted(signal);
    const abortScope = createAbortScope(signal, 15_000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: abortScope.signal,
      });

      if (!response.ok) {
        await cancelUnusedWebResponseBody(response);
        throw new WebToolError(WEB_ERROR_CODES.HTTP_STATUS, `HTTP ${response.status}: ${response.statusText}`);
      }

      // 审计 #13（2026-10-24 报告 P1）：fetch 默认 `redirect: 'follow'`。上面只对
      // **初始** URL 做了 scheme 白名单，302 之后的目标 URL 从未校验 —— 一个已授权的
      // 公网 URL 可以被导向 `http://169.254.169.254/latest/meta-data/` 这类内网地址。
      // 这里对**最终 URL**（response.url）重新校验，并拒绝 https→http 降级。
      // ⚠ 已知边界：本检查只挡住「重定向到非法 scheme / 协议降级」，不挡
      // 「重定向到另一个 http 私有 IP」—— 后者需要 DNS 层解析 + 私有网段判定，
      // 属独立设计项（审计 #13 的完整修法）。
      const finalUrl = response.url || url;
      let finalParsed: URL | null = null;
      try {
        finalParsed = new URL(finalUrl);
      } catch {
        finalParsed = null;
      }
      if (!finalParsed || (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:')) {
        await cancelUnusedWebResponseBody(response);
        throw new WebToolError(WEB_ERROR_CODES.UNSUPPORTED_REDIRECT, `Redirected to unsupported URL: ${finalUrl}`);
      }
      if (parsedUrl.protocol === 'https:' && finalParsed.protocol === 'http:') {
        await cancelUnusedWebResponseBody(response);
        throw new WebToolError(WEB_ERROR_CODES.HTTPS_TO_HTTP, `Refused redirect from https to http: ${finalUrl}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;

      if (contentType.includes('text/html') || contentType.includes('text/plain') || contentType.includes('application/json')) {
        // 审计 #14（2026-10-24 报告 P1）：原来是 `await response.text()` ——
        // 既不查 Content-Length 也不限长，50_000 的截断发生在**整段读完之后**，
        // 恶意/异常 server 返回 500MB 就能撑爆 SW 内存。改成边读边限。
        text = await readTextWithByteLimit(response, WEB_FETCH_MAX_RESPONSE_BYTES);
      } else {
        // 审计 #62：非文本 Content-Type（octet-stream / 图片 / PDF 等）无法提取文本。
        // 旧实现返回 ok:true 但 output 里没有内容 —— 模型会以为抓取成功，接着基于
        // 空内容胡说。改为 ok:false + 明确 error.code，让模型知道「抓到了但读不了」。
        await cancelUnusedWebResponseBody(response);
        return {
          ok: false,
          name: call.name,
          provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
          summary: translate(locale, 'tool.web.unsupportedContentTypeSummary', { contentType }),
          detail: translate(locale, 'tool.web.unsupportedContentTypeDetail', { contentType, url }),
          error: {
            code: 'UNSUPPORTED_CONTENT_TYPE',
            message: `Cannot extract text from non-document content-type: ${contentType || '(unknown)'}`,
            retryable: false,
            details: { url, contentType },
          },
        };
      }

      const extracted = contentType.includes('text/html') ? extractTextFromHtml(text) : text;
      const maxLength = 50_000;
      const truncated = extracted.length > maxLength;
      const outputText = truncated
        ? extracted.slice(0, maxLength) +
          translate(locale, 'tool.web.truncated', { count: extracted.length })
        : extracted;

      return {
        ok: true,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.fetchComplete', { url }),
        detail: truncated
          ? translate(locale, 'tool.web.fetchTruncatedDetail', { length: extracted.length, maxLength })
          : translate(locale, 'tool.web.fetchLengthDetail', { length: extracted.length }),
        output: { url, content: outputText, contentType, truncated } as unknown as JsonValue,
      };
    } finally {
      abortScope.cleanup();
    }
  } catch (error) {
    throwIfWebToolAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    // #58: 结构化分类 —— 替换原字符串匹配（message.includes('Failed to fetch') 等）
    const code = extractWebErrorCode(error);
    const isPermissionError = code === WEB_ERROR_CODES.PERMISSION_DENIED;
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.fetchFailed'),
      detail: isPermissionError
        ? translate(locale, 'tool.web.missingHostPermission', { url })
        : message,
      error: {
        code: isPermissionError ? 'fetch_permission_denied' : 'fetch_failed',
        message: isPermissionError
          ? `Host permission for ${parsedUrl.origin} is not granted.`
          : message,
        retryable: isPermissionError,
      },
    };
  }
}

async function cancelUnusedWebResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch (error) {
    console.warn('[DeepSeek++] Failed to cancel an unused web response body:', error);
  }
}

/**
 * 审计 #14（2026-10-24 报告 P1）：按字节上限读取文本响应体。
 *
 * 原实现直接 `await response.text()`，既不查 Content-Length 也不限长 ——
 * `maxLength = 50_000` 的截断发生在**整段读完之后**，恶意/异常 server 返回 500MB
 * 就能把 SW 内存撑爆。这里边读边累计，超限即取消流并停止。
 */
async function readTextWithByteLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelUnusedWebResponseBody(response);
    throw new WebToolError(WEB_ERROR_CODES.RESPONSE_TOO_LARGE, `Response is larger than ${maxBytes} bytes (declared ${declared}).`);
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        // 超限：立刻停读并取消余下流，避免把剩余字节继续拉进内存
        await reader.cancel().catch(() => {});
        throw new WebToolError(WEB_ERROR_CODES.RESPONSE_TOO_LARGE, `Response exceeded ${maxBytes} bytes; truncated read.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function throwIfWebToolAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Web tool execution was aborted.', 'AbortError');
}

function extractTextFromHtml(html: string): string {
  // Strip scripts and styles
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text.replace(/[\r\n]+/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}
