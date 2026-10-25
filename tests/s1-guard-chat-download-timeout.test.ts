/**
 * S1 守护用例（审计 P2-62，entrypoints/background/chat-runtime-service.ts runImageUpload）。
 *
 * runImageUpload 是 createChatRuntimeService 内部的私有闭包，行为驱动需要整套 SW 宿主
 * （createImageBitmap/OffscreenCanvas/完整 service 依赖），与 content.ts 同理采用**精确结构
 * 断言**：URL 下载必须把 controller.signal 与独立 60s 超时组合，任一触发即 abort。
 *
 * 变异验证：把 `signal: downloadSignal` 改回 `signal: controller.signal` ⇒ 下面的组合串
 * 消失 ⇒ 本用例红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('S1 P2-62: URL 下载补独立 60s 超时', () => {
  const source = readFileSync(join(process.cwd(), 'entrypoints/background/chat-runtime-service.ts'), 'utf8');

  it('定义独立下载超时常量', () => {
    expect(source).toContain('const DOWNLOAD_TIMEOUT_MS = 60_000;');
  });

  it('fetch 使用 controller.signal 与 60s 超时的组合 signal', () => {
    expect(source).toContain(
      'const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);',
    );
    expect(source).toContain('const response = await fetch(url, { signal: downloadSignal });');
  });
});
