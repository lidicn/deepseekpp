import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  waitForUploadedFileReady,
  FILE_READY_POLL_INTERVAL_MS,
  type DeepSeekUploadedFile,
} from '../core/deepseek/active-client';

// 内部状态对象（驼峰，符合 DeepSeekUploadedFile 接口）
const PROCESSING_FILE: DeepSeekUploadedFile = {
  id: 'file-1',
  fileName: 'a.png',
  fileSize: 3,
  mimeType: 'image/png',
  status: 'PROCESSING',
  signedPath: null,
  auditResult: null,
  retryable: null,
  width: null,
  height: null,
};

// API 返回格式（蛇形，normalizeUploadedFile 会转为驼峰）
const PROCESSING_RESP = {
  data: {
    biz_code: 0,
    biz_data: {
      files: [
        {
          id: 'file-1',
          status: 'PROCESSING',
          file_name: 'a.png',
          file_size: 3,
          mime_type: 'image/png',
        },
      ],
    },
  },
};

function jsonResp(v: unknown): Response {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('#43 waitForUploadedFileReady abort guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('abort after sleep → immediately throws AbortError, no more metadata fetches', async () => {
    vi.useFakeTimers();
    let metadataCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v0/file/fetch_files')) {
          metadataCalls++;
          return jsonResp(PROCESSING_RESP);
        }
        return jsonResp({ data: { biz_code: 0 } });
      }),
    );

    const ctrl = new AbortController();
    const promise = waitForUploadedFileReady(PROCESSING_FILE, {}, ctrl.signal);

    // Advance 1st sleep → 进入循环1，L472 检查通过，sleep，L474 检查，metadata fetch
    await vi.advanceTimersByTimeAsync(FILE_READY_POLL_INTERVAL_MS);
    await Promise.resolve(); // 让微任务跑一下（处理 fetch）
    expect(metadataCalls).toBe(1);

    // 此时循环2 刚进入 sleep 等待中。abort！
    // sleep 因 signal abort 立即 reject，整个 promise reject
    ctrl.abort();
    await Promise.resolve();

    const err: any = await promise.then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(err?.name).toBe('AbortError');
    expect(ctrl.signal.aborted).toBe(true);
    // 关键断言：abort 后不应再发起 fetch
    expect(metadataCalls).toBe(1);
  });

  it('abort before first sleep → throws immediately, zero metadata fetches', async () => {
    vi.useFakeTimers();
    let metadataCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/v0/file/fetch_files')) {
          metadataCalls++;
          return jsonResp(PROCESSING_RESP);
        }
        return jsonResp({ data: { biz_code: 0 } });
      }),
    );

    const ctrl = new AbortController();
    // 在调用前 abort
    ctrl.abort();
    const promise = waitForUploadedFileReady(PROCESSING_FILE, {}, ctrl.signal);

    await Promise.resolve();

    const err: any = await promise.then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(err?.name).toBe('AbortError');
    expect(ctrl.signal.aborted).toBe(true);
    expect(metadataCalls).toBe(0); // 连一次都不应发起
  });
});
