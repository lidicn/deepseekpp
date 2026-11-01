/**
 * t5-c：augmentation「静默 passthrough / 静默失效」必须落诊断 + 最小修复（无工具降级增强）。
 *
 * 现场（t4 `验收-修后.md` §3.1）：B3 r5/r6 两轮 T1/T2 全部 passthrough
 * （prompt 17B/43B、`request: payload=229B/249B tools=0B`），发生在 30.5s 静默截断 +
 * 工具熔断之后，下一轮自愈 ⇒ 用户视角是"工具/记忆/系统提示突然都没了"，且**零诊断**。
 *
 * 修复约定：
 *   1. 每条 passthrough 都要有 reason 码（decode_failed / regenerate_scope_missing /
 *      extension_invalidated / augmentation_error）；
 *   2. 工具授权失败时**不整段透传**，降级为「无工具增强」（保住记忆/技能/系统提示），
 *      并落 `chat/augmentation_degraded_no_tools`。
 *
 * 变异自证：删掉 `recordAugmentationDegradedWithoutTools(...)` 调用（回到静默） ⇒ 本用例红；
 *          删掉任一 passthrough 的 reason 码 ⇒ 对应用例红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTENT_SOURCE = readFileSync(
  join(__dirname, '..', 'entrypoints', 'content.ts'),
  'utf-8',
);

describe('augmentation passthrough 诊断（t5-c）', () => {
  it('★ 持久诊断键与四个 reason 码都在（不再有"零诊断"的降级路径）', () => {
    expect(CONTENT_SOURCE).toContain('message: "augmentation_passthrough"');
    for (const reason of [
      'decode_failed',
      'regenerate_scope_missing',
      'extension_invalidated',
      'augmentation_error',
    ]) {
      expect(CONTENT_SOURCE).toContain(`"${reason}"`);
    }
  });

  it('★★ 工具授权失败 ⇒ 降级为「无工具增强」，而不是整段静默透传', () => {
    // 降级诊断
    expect(CONTENT_SOURCE).toContain('message: "augmentation_degraded_no_tools"');
    expect(CONTENT_SOURCE).toContain('reason=authorization_failed');
    // 只包住授权调用（其余注入照常）：catch 里把 authorization 置空并落诊断
    const authTry = CONTENT_SOURCE.indexOf('recordAugmentationDegradedWithoutTools(');
    expect(authTry).toBeGreaterThan(0);
    const authBlock = CONTENT_SOURCE.slice(authTry - 900, authTry + 200);
    expect(authBlock).toContain('createContentToolAuthorization({');
    expect(authBlock).toContain('authorization = null;');
    // 增强与回包都按「无授权 ⇒ 无工具目录」降级，但 prompt 仍被增强。
    expect(CONTENT_SOURCE).toContain('toolDescriptors: authorization?.descriptors ?? [],');
    expect(CONTENT_SOURCE).toContain('augmentDecodedRequestBody(bodyWithMultimodalMedia, {');
    // 只剩 regenerate 分支（授权必存在）还允许直接解引用。
    const directRefs = CONTENT_SOURCE.match(/toolDescriptors: authorization\.descriptors,/g) ?? [];
    expect(directRefs.length).toBe(1);
  });

  it('★ 降级路径错误信息经过裁剪（不把整段错误/敏感上下文写进诊断）', () => {
    expect(CONTENT_SOURCE).toContain('function formatAugmentationError(');
    expect(CONTENT_SOURCE).toContain('.slice(0, 160)');
  });
});
