/**
 * 工具目录预算与选择守卫。
 *
 * 目标：catalog 24,084B → ≤8,000B，且**一个工具都不丢**（未选中的只给名字）。
 *
 * 变异（可判红）：
 *   - 去掉 `fullBytes + cost <= budgetBytes` 判定 ⇒ 用例 1 红
 *   - 把 indexOnly 直接丢弃 ⇒ 用例 2 红
 *   - `budgetBytes=0` 分支改成也裁剪 ⇒ 用例 3 红
 *   - alwaysInclude 不置顶 ⇒ 用例 4 红
 */
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_FULL_TOOLS,
  CATALOG_NAME_INDEX_HEADER,
  DEFAULT_CATALOG_BUDGET_BYTES,
  renderCatalogNameIndex,
  scoreCatalogTool,
  selectCatalogTools,
} from '../core/prompt/catalog-selection';

interface Tool {
  name: string;
  title: string;
  description: string;
  bytes: number;
}

const tool = (name: string, title: string, description = '', bytes = 500): Tool => ({
  name,
  title,
  description,
  bytes,
});

const MEASURE = (t: Tool) => t.bytes;

const TOOLS: Tool[] = [
  tool('shell_exec', 'Run a shell command', 'execute local commands'),
  tool('shell_status', 'Check shell status'),
  tool('web_search', 'Search the web'),
  tool('web_fetch', 'Fetch a URL'),
  tool('memory_save', 'Save a memory'),
  tool('docx_write', 'Write a Word document', 'docx export'),
  tool('xlsx_write', 'Write a spreadsheet', 'xlsx export'),
  tool('pet_toggle', 'Toggle the desktop pet'),
];

describe('selectCatalogTools · 预算', () => {
  it('★ 预算内只给 top-k 完整块，且总量不超预算', () => {
    const result = selectCatalogTools({
      tools: TOOLS,
      userText: '帮我审计这个仓库的代码',
      measure: MEASURE,
      budgetBytes: 2_500,
    });
    expect(result.bytes.full).toBeLessThanOrEqual(2_500);
    expect(result.full.length).toBeGreaterThan(0);
    expect(result.full.length).toBeLessThan(TOOLS.length);
  });

  it('★★ 一个工具都不丢：full + indexOnly === 全部', () => {
    const result = selectCatalogTools({
      tools: TOOLS,
      userText: 'x',
      measure: MEASURE,
      budgetBytes: 1_200,
    });
    const names = [...result.full, ...result.indexOnly].map((t) => t.name).sort();
    expect(names).toEqual(TOOLS.map((t) => t.name).sort());
    expect(result.indexOnly.length).toBeGreaterThan(0);
  });

  it('★ budgetBytes=0 ⇒ 全量（回滚路径，字节级等于今日行为）', () => {
    const result = selectCatalogTools({
      tools: TOOLS,
      userText: 'x',
      measure: MEASURE,
      budgetBytes: 0,
    });
    expect(result.full.length).toBe(TOOLS.length);
    expect(result.indexOnly).toEqual([]);
    expect(result.bytes.full).toBe(TOOLS.reduce((s, t) => s + t.bytes, 0));
  });

  it('★ alwaysInclude 即使超预算也给完整块', () => {
    const result = selectCatalogTools({
      tools: TOOLS,
      userText: '完全无关的问题',
      measure: MEASURE,
      budgetBytes: 600, // 只够一个
    });
    for (const name of ALWAYS_FULL_TOOLS) {
      if (TOOLS.some((t) => t.name === name)) {
        expect(result.full.map((t) => t.name)).toContain(name);
      }
    }
  });

  it('★ 相关性：用户提到 docx 时，docx 工具必须进完整块', () => {
    const result = selectCatalogTools({
      tools: TOOLS,
      userText: '把这个 docx 文档转成 pdf',
      measure: MEASURE,
      budgetBytes: 3_000,
      reserveBytes: 0,
    });
    expect(result.full.map((t) => t.name)).toContain('docx_write');
  });

  it('负控：确定性（同输入同输出）', () => {
    const run = () =>
      selectCatalogTools({ tools: TOOLS, userText: 'shell 命令', measure: MEASURE, budgetBytes: 2_000 })
        .full.map((t) => t.name);
    expect(run()).toEqual(run());
  });

  it('负控：空工具列表不炸', () => {
    const result = selectCatalogTools({ tools: [], userText: 'x', measure: MEASURE, budgetBytes: 8_000 });
    expect(result.full).toEqual([]);
    expect(result.bytes.total).toBe(0);
  });
});

describe('打分与名称索引', () => {
  it('★ 名字命中高于描述命中', () => {
    const tokens = ['shell'];
    const byName = scoreCatalogTool(tool('shell_exec', 'Run'), tokens, []);
    const byDesc = scoreCatalogTool(tool('other', 'Other', 'shell related'), tokens, []);
    expect(byName).toBeGreaterThan(byDesc);
  });

  it('★ alwaysInclude 直接置顶', () => {
    expect(scoreCatalogTool(tool('web_search', 'Search'), [], ALWAYS_FULL_TOOLS)).toBeGreaterThan(100);
  });

  it('★ 名称索引：一行一个工具，含名字与标题', () => {
    const text = renderCatalogNameIndex([tool('shell_exec', 'Run a shell command')]);
    expect(text).toContain(CATALOG_NAME_INDEX_HEADER);
    expect(text).toContain('- shell_exec: Run a shell command');
  });

  it('负控：空列表不产生空标题', () => {
    expect(renderCatalogNameIndex([])).toBe('');
  });

  it('★ 默认预算为 8000（24KB → 8KB 的目标值）', () => {
    expect(DEFAULT_CATALOG_BUDGET_BYTES).toBe(8_000);
  });
});
