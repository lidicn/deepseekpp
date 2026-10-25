/**
 * S1 守护用例（审计 P2-49，core/sync/webdav-client.ts webdavMkcol）。
 *
 * 修复前：MKCOL 返回 301 被当作「目录已存在」静默放行，后续 PUT 到旧路径才报错。
 * 修复后：仅 405(已存在) 或 2xx(创建成功) 视为成功，其余落到错误分支。
 * 这里打桩 fetch 返回指定 status，断言 301 必须抛错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webdavMkcol } from '../core/sync/webdav-client';
import type { WebdavSyncConfig } from '../core/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = {
  type: 'webdav',
  url: 'https://dav.example.com/dav/',
  remotePath: 'dpp/backups',
  username: 'u',
  password: 'p',
} as unknown as WebdavSyncConfig;

function fakeStatus(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe('S1 P2-49: MKCOL 的 301 不再被当成「目录已存在」', () => {
  it('301 ⇒ 抛错（走错误分支，不再静默 return）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeStatus(301)));
    await expect(webdavMkcol(config)).rejects.toThrow(/创建远程目录失败 \(HTTP 301\)/);
  });

  it('对照：405（已存在）与 2xx（创建成功）仍视为成功，不误伤', async () => {
    for (const okStatus of [405, 200, 201]) {
      vi.stubGlobal('fetch', vi.fn(async () => fakeStatus(okStatus)));
      await expect(webdavMkcol(config)).resolves.toBeUndefined();
    }
  });
});
