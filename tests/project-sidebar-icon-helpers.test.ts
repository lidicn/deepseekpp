import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// P1-7 静态 icon helper 守护（比 grep 源码文本更稳）。
// 背景：project-sidebar-organizer.ts:841/:913 用 button.innerHTML = options.icon，
// options.icon 全部来自 1149-1169 的无参静态 helper。当前安全；风险在将来——
// 若有人把这些 helper 改成接受参数并传入用户数据，innerHTML 就变成注入口。
// 本测试锁住「它们仍是无参函数」以及「赋值点仍在原位置」。
const source = readFileSync(
  join(process.cwd(), 'entrypoints/content/adapters/project-sidebar-organizer.ts'),
  'utf8',
);

describe('P1-7 静态 icon helper 仍是无参函数', () => {
  it('五个 helper 签名均为 function name(): string', () => {
    for (const name of ['folderIcon', 'addIcon', 'unlinkIcon', 'clockIcon', 'moreIcon']) {
      expect(source).toMatch(new RegExp(`function ${name}\\(\\): string`));
    }
  });

  it('两个 innerHTML 赋值点仍只消费 options.icon', () => {
    // :841 / :913 —— 结构不变式：icon 经由 options.icon 注入，
    // 不直接拼接用户输入。
    expect(source).toContain('button.innerHTML = options.icon;');
    expect(source).toContain('button.innerHTML = `${options.icon}<span>${escapeHtml(options.label)}</span>`;');
  });
});
