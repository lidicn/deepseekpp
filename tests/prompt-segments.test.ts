/**
 * Prompt 分段字节表守卫。
 *
 * 变异（可判红）：
 *   - 把 catalog 结束点写死成 `prompt.length` ⇒ 用例 1 的 tail 变 0 ⇒ 红
 *   - 记忆标记正则去掉英文分支 ⇒ 用例 4 红
 */
import { describe, expect, it } from 'vitest';
import { countCatalogTools, formatPromptSegments, measurePromptSegments } from '../core/debug/prompt-segments';

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

const ZH_PROMPT = [
  '## Tools',
  '### Extended Capabilities',
  '- Local command execution',
  '### Available Tools',
  '### Tool shell_exec',
  'Title: Run a shell command',
  'Parameters JSON Schema: {"type":"object"}',
  '## 已有记忆',
  '- 用户偏好：深色主题',
  '## 记忆保存规则',
  '- 仅在用户明确要求时保存',
  '### 搜索流程',
  '用户问题：审计一下这个仓库',
].join('\n');

describe('measurePromptSegments', () => {
  it('★ 四段切分且总和等于全文（catalog 只到下一个 ## 为止）', () => {
    const seg = measurePromptSegments(ZH_PROMPT);
    expect(seg.total).toBe(bytes(ZH_PROMPT));
    expect(seg.base + seg.catalog + seg.memory + seg.tail).toBe(seg.total);

    // catalog 必须包含目录内容，但不包含记忆段
    const catalogStart = ZH_PROMPT.indexOf('### Available Tools');
    const memoryStart = ZH_PROMPT.indexOf('## 已有记忆');
    expect(seg.catalog).toBe(bytes(ZH_PROMPT.slice(catalogStart, memoryStart)));
    expect(seg.memory).toBeGreaterThan(0);
    expect(seg.tail).toBeGreaterThan(0);
    expect(seg.base).toBe(bytes(ZH_PROMPT.slice(0, catalogStart)));
  });

  it('★ 没有目录标记 ⇒ 全算 base，其余为 0（不瞎猜）', () => {
    const seg = measurePromptSegments('just a plain prompt without sections');
    expect(seg.catalog).toBe(0);
    expect(seg.memory).toBe(0);
    expect(seg.tail).toBe(0);
    expect(seg.base).toBe(seg.total);
  });

  it('负控：空串全 0，不抛错', () => {
    expect(measurePromptSegments('')).toEqual({ base: 0, catalog: 0, memory: 0, tail: 0, total: 0 });
  });

  it('★ 英文模板（## Existing Memories）也能切出记忆段', () => {
    const en = [
      '## Tools',
      '### Available Tools',
      '### Tool shell_exec',
      '## Existing Memories',
      '- prefers dark mode',
      '## Memory Rules',
      'user: audit the repo',
    ].join('\n');
    const seg = measurePromptSegments(en);
    expect(seg.memory).toBeGreaterThan(0);
    expect(seg.base + seg.catalog + seg.memory + seg.tail).toBe(seg.total);
  });

  it('负控：只有目录、没有后续段落 ⇒ tail 为 0', () => {
    const only = '## Tools\n### Available Tools\n### Tool a\n';
    const seg = measurePromptSegments(only);
    expect(seg.tail).toBe(0);
    expect(seg.catalog).toBeGreaterThan(0);
  });

  it('★ 一行格式含全部四个键（供 [DPP-DEBUG] 直接拼）', () => {
    const line = formatPromptSegments(measurePromptSegments(ZH_PROMPT));
    for (const key of ['base ', 'catalog ', 'memory ', 'tail ']) expect(line).toContain(key);
  });
});
describe('countCatalogTools（2.5 观测）', () => {
  it('★ 分别数出完整块与只给名字的工具', () => {
    const prompt = [
      '## Tools',
      '### Available Tools',
      '### Tool shell_exec',
      'Title: Run shell',
      '### Tool web_search',
      'Title: Search',
      '### Other tools (name only)',
      '- docx_write: Write a Word document',
      '- xlsx_write: Write a spreadsheet',
      '## 已有记忆',
      '- 某条记忆',
    ].join('\n');
    expect(countCatalogTools(prompt)).toEqual({ full: 2, indexOnly: 2 });
  });

  it('负控：没有索引段 ⇒ indexOnly=0；没有目录 ⇒ 全 0', () => {
    expect(countCatalogTools('### Available Tools\n### Tool a\n')).toEqual({ full: 1, indexOnly: 0 });
    expect(countCatalogTools('plain text')).toEqual({ full: 0, indexOnly: 0 });
  });

  it('负控：索引段遇到下一个 ## 标题即停止（不把记忆条目算进去）', () => {
    const prompt = [
      '### Other tools (name only)',
      '- a: A',
      '## 记忆',
      '- b: B',
    ].join('\n');
    expect(countCatalogTools(prompt)).toEqual({ full: 0, indexOnly: 1 });
  });
});