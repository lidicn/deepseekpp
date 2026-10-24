import type { WebdavSyncConfig } from '../types';

// WebDAV 请求超时：服务器无响应时避免同步永久挂起（ADM 审计 X4）。
// 大文件上传下载走 streaming，30s 对建连 + 首字节足够。
const WEBDAV_FETCH_TIMEOUT_MS = 30_000;

function webdavFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(WEBDAV_FETCH_TIMEOUT_MS) });
}

function buildUrl(config: WebdavSyncConfig, file?: string): string {
  const base = config.url.replace(/\/+$/, '');
  const path = config.remotePath.replace(/^\/+|\/+$/g, '');
  if (file) return `${base}/${path}/${file}`;
  return `${base}/${path}`;
}

function headers(config: WebdavSyncConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: 'Basic ' + toBase64Utf8(`${config.username}:${config.password}`),
    ...extra,
  };
}

/**
 * UTF-8-safe base64 for the Basic auth header. `btoa` throws on non-Latin-1
 * characters (e.g. CJK credentials), breaking WebDAV sync entirely (M9).
 */
function toBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function webdavTest(config: WebdavSyncConfig): Promise<void> {
  const url = config.url.replace(/\/+$/, '') + '/';
  const res = await webdavFetch(url, {
    method: 'PROPFIND',
    headers: headers(config, { Depth: '0' }),
  });
  if (res.status === 401) throw new Error('认证失败，请检查用户名和密码');
  if (res.status === 403) throw new Error('访问被拒绝');
  if (res.status === 404) throw new Error('服务器地址不存在');
  if (res.status !== 207 && !res.ok) throw new Error(`连接失败 (HTTP ${res.status})`);
}

export async function webdavMkcol(config: WebdavSyncConfig): Promise<void> {
  const url = buildUrl(config) + '/';
  const res = await webdavFetch(url, {
    method: 'MKCOL',
    headers: headers(config),
  });
  // 审计 P2-49：301 是重定向（远程路径被移走），原实现当"目录已存在"放行，
  // 后续 PUT 到旧路径会继续跟随/失败却不报错。移除 301，仅 405(已存在) 或
  // 2xx(创建成功) 视为成功，其余落到错误分支。
  if (res.status === 405 || (res.status >= 200 && res.status < 300)) return;
  if (res.status === 409) throw new Error(`无法创建远程目录，请确认父目录存在: ${config.remotePath}`);
  throw new Error(`创建远程目录失败 (HTTP ${res.status})`);
}

export async function webdavGet(config: WebdavSyncConfig, file: string): Promise<string | null> {
  const url = buildUrl(config, file);
  const res = await webdavFetch(url, {
    method: 'GET',
    headers: headers(config),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`下载 ${file} 失败 (HTTP ${res.status})`);
  return res.text();
}

export async function webdavPut(config: WebdavSyncConfig, file: string, content: string): Promise<void> {
  const url = buildUrl(config, file);
  const res = await webdavFetch(url, {
    method: 'PUT',
    headers: headers(config, { 'Content-Type': 'application/json; charset=utf-8' }),
    body: content,
  });
  if (!res.ok) throw new Error(`上传 ${file} 失败 (HTTP ${res.status})`);
}
