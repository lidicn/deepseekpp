/**
 * 审计 #70：版本比较必须处理 semver pre-release 后缀。
 *
 * 原实现只取 `^\d+(\.\d+)*`：`1.2.3-beta` 被截成 `[1,2,3]` ⇒ 与 `1.2.3` 判等，
 * 于是"测试版宿主是否过期/过新"永远判不出来（semver 里 `1.2.3-beta < 1.2.3`）。
 *
 * 变异方式：让 `comparePrerelease` 恒返回 0 ⇒ 本文件所有 ★ 用例必须红。
 */
import { describe, expect, it } from 'vitest';
import { isNewerVersion, isOlderVersion } from '../core/mcp/native-host-version';

describe('审计 #70：pre-release 版本比较', () => {
  it('★ 正式版比同号预发布版新：1.2.3-beta < 1.2.3', () => {
    expect(isOlderVersion('1.2.3-beta', '1.2.3')).toBe(true);
    expect(isOlderVersion('1.2.3', '1.2.3-beta')).toBe(false);
  });

  it('★ 预发布标识符按字典序：alpha < beta', () => {
    expect(isOlderVersion('1.2.3-alpha', '1.2.3-beta')).toBe(true);
    expect(isOlderVersion('1.2.3-beta', '1.2.3-alpha')).toBe(false);
  });

  it('★ 数字标识符按数值比较：beta.2 < beta.10（不是字典序）', () => {
    expect(isOlderVersion('1.2.3-beta.2', '1.2.3-beta.10')).toBe(true);
    expect(isOlderVersion('1.2.3-beta.10', '1.2.3-beta.2')).toBe(false);
  });

  it('★ 更短的预发布更旧：1.2.3-beta < 1.2.3-beta.1', () => {
    expect(isOlderVersion('1.2.3-beta', '1.2.3-beta.1')).toBe(true);
  });

  it('★ isNewerVersion 与 isOlderVersion 必须自洽（双向）', () => {
    expect(isNewerVersion('1.2.3', '1.2.3-beta')).toBe(true);
    expect(isNewerVersion('1.2.3-beta', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3-beta.10', '1.2.3-beta.2')).toBe(true);
  });

  it('负控：完全相同的版本两个方向都 false', () => {
    expect(isOlderVersion('1.2.3-beta', '1.2.3-beta')).toBe(false);
    expect(isNewerVersion('1.2.3-beta', '1.2.3-beta')).toBe(false);
  });

  it('负控：纯数字版本的既有比较行为不变', () => {
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isOlderVersion('1.2.10', '1.2.9')).toBe(false);
    expect(isOlderVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.16.0', '1.14.0')).toBe(true);
  });

  it('负控：undefined / 非字符串仍返回 false（不抛错）', () => {
    expect(isOlderVersion(undefined, '1.16.0')).toBe(false);
    expect(isOlderVersion('1.16.0', undefined)).toBe(false);
    expect(isOlderVersion(42, '1.16.0')).toBe(false);
  });
});
