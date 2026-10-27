/**
 * 侧边栏 i18n 命名空间边界守卫。
 *
 * 背景：`core/i18n/sidepanel-resources.ts` 只聚合 6 个命名空间
 * （common / manifest / app / locale / sidepanel / pet）。侧边栏走这套资源集，
 * 是为了不把 background/content 的字典（实测 ~72 KB raw）经共享 runtime chunk
 * 带进初始壳。
 *
 * 风险：若有人在侧边栏代码里写了 `t('tool.xxx')` 这类**不在子集内**的键，
 * 类型上仍是合法的（`LocaleMessageKey` 覆盖全树），运行时会**静默回退成 key 字符串**
 * —— 界面出现 `tool.foo.bar` 字样，但构建、tsc、既有测试全绿。
 *
 * 本文件把这条守住：静态扫描 `entrypoints/sidepanel/**` 的键字面量，
 * 出现子集外的命名空间即红。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SIDEPANEL_NAMESPACES } from '../core/i18n/sidepanel-resources';

const SIDEPANEL_DIR = 'entrypoints/sidepanel';
const ALL_NAMESPACES = [
  'common', 'manifest', 'app', 'locale', 'sidepanel', 'content', 'background', 'tool', 'prompt', 'pet',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('侧边栏 i18n 命名空间边界', () => {
  it('子集恰好是 6 个命名空间（改动必须同步本测试）', () => {
    expect([...SIDEPANEL_NAMESPACES].sort()).toEqual(
      ['app', 'common', 'locale', 'manifest', 'pet', 'sidepanel'],
    );
  });

  it('★ 侧边栏代码不得引用子集外的 i18n 命名空间', () => {
    const allowed = new Set<string>(SIDEPANEL_NAMESPACES);
    const offenders: string[] = [];
    const keyRe = new RegExp(`['"\`](${ALL_NAMESPACES.join('|')})\\.[A-Za-z0-9_.]+['"\`]`, 'g');

    for (const file of walk(SIDEPANEL_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(keyRe)) {
        const ns = m[1];
        // 类型导入里出现的命名空间名（如 `import type { X } from '../../core/i18n'`）不算键字面量，
        // 因为正则要求 `'ns.'` 或 `"ns."` 或 `` `ns. `` 形式，纯模块说明不会命中。
        if (!allowed.has(ns)) offenders.push(`${file}: ${m[0]}`);
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});
