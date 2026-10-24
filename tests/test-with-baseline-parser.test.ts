// 门禁尺自身的守护（审计 X-52）。
//
// 背景：`scripts/test-with-baseline.mjs` 是 `ci:quality` 里判定「有没有新增 failed」
// 的那道门。它曾连续四次被审计报出「解析失效」，病灶在取材面：
// vitest 的 verbose 输出**带 ANSI 转义码**，而门用 `^\s*×\s+...` 做行首匹配，
// 于是永远命中 0 条 failed，把「没看见红」当成「没有红」，恒 `exit 0`。
//
// 这是最危险的一类缺陷：**门自己坏了，其他所有测试的绿都失去意义**。
// 所以门禁尺的解析必须与「跑 vitest」的副作用分开，并能被直接单测 ——
// 逻辑已抽到 `scripts/lib/vitest-output.mjs`，本文件是它的守护。
import { describe, expect, it } from 'vitest';
import {
  findStaleBaselineEntries,
  isCoveredByBaseline,
  parseFailedCases,
  stripAnsi,
} from '../scripts/lib/vitest-output.mjs';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('removes colour escapes and CR', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m`)).toBe('red');
    expect(stripAnsi('a\r\nb')).toBe('a\nb');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('parseFailedCases', () => {
  it('parses a real vitest verbose failure line WITH ANSI escapes', () => {
    // 这是修复前恒失败的那条形状：`×` 前面有色码，`^\s*×` 匹配不到
    const output = [
      ' RUN  v4.1.8',
      '',
      ` ${ESC}[31m×${ESC}[39m tests/persistence-burst-budget.test.ts > burst budget > rejects partial state ${ESC}[2m1234ms${ESC}[22m`,
      '',
      ' Test Files  1 failed (1)',
    ].join('\n');

    const failed = parseFailedCases(output);
    expect(failed.size).toBe(1);
    expect([...failed][0]).toBe(
      'tests/persistence-burst-budget.test.ts > burst budget > rejects partial state',
    );
  });

  it('parses the same line when escapes are already stripped', () => {
    const output = '   × tests/a.test.ts > suite > case 12ms\n';
    expect([...parseFailedCases(output)]).toEqual(['tests/a.test.ts > suite > case']);
  });

  it('does NOT start mid-line when a describe name itself contains ×', () => {
    // 2026-10-20 的老病灶：非锚定正则会从 describe 名里的 `×` 开始截
    const output = '   × tests/pi.test.ts > pi bridge × runtime authorization (A2-T3) 45ms\n';
    const [parsed] = [...parseFailedCases(output)];
    expect(parsed).toBe('tests/pi.test.ts > pi bridge × runtime authorization (A2-T3)');
    expect(parsed.startsWith('tests/pi.test.ts')).toBe(true);
  });

  it('returns nothing for an all-green output', () => {
    const output = [
      ' ✓ tests/a.test.ts (3 tests) 10ms',
      ' Test Files  1 passed (1)',
      '      Tests  3 passed (3)',
    ].join('\n');
    expect(parseFailedCases(output).size).toBe(0);
  });

  it('does not treat the ✓ success marker as a failure', () => {
    const output = ` ${ESC}[32m✓${ESC}[39m tests/a.test.ts (1 test) 5ms\n`;
    expect(parseFailedCases(output).size).toBe(0);
  });
});

describe('isCoveredByBaseline', () => {
  it('covers a case by file-level entry with ` > ` separator', () => {
    const baseline = new Set(['tests/a.test.ts']);
    expect(isCoveredByBaseline('tests/a.test.ts > suite > case', baseline)).toBe(true);
  });

  it('covers a case by file-level entry with `::` separator', () => {
    const baseline = new Set(['tests/a.test.ts']);
    expect(isCoveredByBaseline('tests/a.test.ts::suite::case', baseline)).toBe(true);
  });

  it('covers an exact case-name entry', () => {
    const baseline = new Set(['tests/a.test.ts > suite > case']);
    expect(isCoveredByBaseline('tests/a.test.ts > suite > case', baseline)).toBe(true);
  });

  it('does not cover a different file', () => {
    const baseline = new Set(['tests/a.test.ts']);
    expect(isCoveredByBaseline('tests/b.test.ts > suite > case', baseline)).toBe(false);
  });

  it('does not cover a sibling file whose name shares a prefix', () => {
    // 防 `startsWith(b + ' > ')` 之外的松散匹配：tests/a.test.ts 不该盖住 tests/ab.test.ts
    const baseline = new Set(['tests/a.test.ts']);
    expect(isCoveredByBaseline('tests/ab.test.ts > suite > case', baseline)).toBe(false);
  });

  it('ignores ::TODO and bare :: placeholders (they would match everything)', () => {
    expect(isCoveredByBaseline('anything at all', new Set(['::TODO']))).toBe(false);
    expect(isCoveredByBaseline('anything at all', new Set(['::']))).toBe(false);
  });
});

describe('gate end-to-end shape (regex ⇄ baseline)', () => {
  it('a real failure inside the baseline yields zero new failures', () => {
    const output = ` ${ESC}[31m×${ESC}[39m tests/persistence-burst-budget.test.ts > burst > leg 900ms\n`;
    const baseline = new Set(['tests/persistence-burst-budget.test.ts']);
    const failed = parseFailedCases(output);
    expect(failed.size).toBe(1);
    const newFailed = [...failed].filter((f) => !isCoveredByBaseline(f, baseline));
    expect(newFailed).toEqual([]);
  });

  it('a real failure OUTSIDE the baseline is reported as new', () => {
    const output = ` ${ESC}[31m×${ESC}[39m tests/regression.test.ts > suite > leg 900ms\n`;
    const baseline = new Set(['tests/persistence-burst-budget.test.ts']);
    const failed = parseFailedCases(output);
    const newFailed = [...failed].filter((f) => !isCoveredByBaseline(f, baseline));
    expect(newFailed).toEqual(['tests/regression.test.ts > suite > leg']);
  });
});

// P0-3 反向校验：基线里指向不存在测试文件的条目必须被揪出来。
describe('findStaleBaselineEntries (reverse check)', () => {
  const existing = ['tests/a.test.ts', 'tests/b.test.ts'];

  it('file-level entry pointing to a deleted file is stale', () => {
    expect(findStaleBaselineEntries(['tests/deleted.test.ts'], existing))
      .toEqual(['tests/deleted.test.ts']);
  });

  it('case-level entry still resolves to its leading test file', () => {
    expect(findStaleBaselineEntries(
      ['tests/deleted.test.ts > suite > case'],
      existing,
    )).toEqual(['tests/deleted.test.ts > suite > case']);
  });

  it('existing file-level and case-level entries are NOT stale', () => {
    expect(findStaleBaselineEntries(
      ['tests/a.test.ts', 'tests/b.test.ts > suite > case'],
      existing,
    )).toEqual([]);
  });

  it('ignores placeholders and non-path entries', () => {
    expect(findStaleBaselineEntries(['::TODO', '::', ''], existing)).toEqual([]);
  });
});
