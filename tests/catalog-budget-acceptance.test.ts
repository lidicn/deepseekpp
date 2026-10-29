/**
 * 工具目录预算的**端到端验收**。
 *
 * 说明：单测环境里 `createDefaultToolDescriptors()` 只有 8 个内置工具（真实机的 42 个
 * 大部分来自 MCP provider），8 个加起来才 3.9KB，无法验证预算。所以这里**克隆并放大**
 * 成 42 个 ≈570B 的工具，忠实模拟真机形态（24,084B / 42 个）。
 *
 * 变异（可判红）：
 *   - 去掉 augmentation 里的选择（改回 `renderToolSchemas(toolDescriptors, …)`）⇒ 用例 1 红
 *   - 只渲染 full、丢掉名称索引 ⇒ 用例 2 红
 *   - `localStorage['dpp:catalogBudget']='0'` 时不回退全量 ⇒ 用例 3 红
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt/augmentation';
import { createDefaultToolDescriptors } from '../core/tool/invocation';
import { measurePromptSegments } from '../core/debug/prompt-segments';
import type { ToolDescriptor } from '../core/types';

const USER_TEXT = '审计 E:\\NAS\\deepseek-pp 找到一个bug，给我一份报告。';

/** 克隆内置描述符成 42 个"大工具"，模拟真机 42 × ≈570B。 */
function makeRealisticDescriptors(): ToolDescriptor[] {
  const base = createDefaultToolDescriptors('zh-CN');
  const out: ToolDescriptor[] = [];
  for (let i = 0; i < 42; i += 1) {
    const template = base[i % base.length] as ToolDescriptor;
    const name = `tool_${String(i).padStart(2, '0')}_${template.name}`.slice(0, 40);
    out.push({
      ...template,
      id: `local:${name}`,
      name,
      invocationName: name,
      title: `${template.title} #${i}`,
      // 把描述撑到 ~400 字符，逼近真机 570B/工具
      description: `${template.description} ${'detail '.repeat(60)}`,
    } as ToolDescriptor);
  }
  return out;
}

function build(descriptors: ToolDescriptor[]) {
  return buildPromptAugmentation(USER_TEXT, { locale: 'zh-CN', toolDescriptors: descriptors });
}

afterEach(() => {
  localStorage.removeItem('dpp:catalogBudget');
});

describe('catalog 预算端到端（42 工具模拟真机）', () => {
  it('★ 默认预算下 catalog ≤ 9,500B（改前同形态 ≈24,000B）', () => {
    const descriptors = makeRealisticDescriptors();
    const seg = measurePromptSegments(build(descriptors).augmented);
    console.log(`  [实测] tools=${descriptors.length} catalog=${seg.catalog}B total=${seg.total}B`);
    expect(seg.catalog).toBeLessThanOrEqual(9_500);
  });

  it('★★ 一个工具都不丢：42 个名字全都在 prompt 里', () => {
    const descriptors = makeRealisticDescriptors();
    const prompt = build(descriptors).augmented;
    const missing = descriptors.map((d) => d.name).filter((name) => !prompt.includes(name));
    expect(missing).toEqual([]);
  });

  it('★ 回滚开关：localStorage dpp:catalogBudget=0 ⇒ 回到全量（>20,000B）', () => {
    const descriptors = makeRealisticDescriptors();
    localStorage.setItem('dpp:catalogBudget', '0');
    const seg = measurePromptSegments(build(descriptors).augmented);
    console.log(`  [回滚] catalog=${seg.catalog}B`);
    expect(seg.catalog).toBeGreaterThan(20_000);
  });

  it('负控：同输入两次构建字节数一致（缓存不改变输出）', () => {
    const descriptors = makeRealisticDescriptors();
    const first = measurePromptSegments(build(descriptors).augmented).catalog;
    const second = measurePromptSegments(build(descriptors).augmented).catalog;
    expect(second).toBe(first);
  });
});
