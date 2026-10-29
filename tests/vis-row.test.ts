/**
 * Row（左图右文）用例 —— 本组件是"加组件零成本"的实证：
 * 只新增 components/row.ts + components/index.ts 里一行 registerVisComponent，未改 registry/render/catalog。
 */
import { describe, expect, it } from 'vitest';
import { getComponentSpec, getRegisteredTypes, renderToHtml } from '../core/vis';

const doc = (root: unknown): unknown => ({ v: 1, root });

describe('Row · 左图右文', () => {
  it('★ 渲染出横向容器，图片与文本都在里面', () => {
    const { html, outcome } = renderToHtml(doc({
      type: 'Row',
      children: [
        { type: 'Image', src: null, alt: '海报', ratio: '2/3', fallback: { hue: 208 } },
        {
          type: 'Column',
          children: [
            { type: 'Text', text: '肖申克的救赎', variant: 'title' },
            { type: 'Text', text: '1994 · 剧情', variant: 'subtitle' },
          ],
        },
      ],
    }));

    expect(outcome.status).toBe('ok');
    expect(html).toContain('dppvis-row');
    expect(html).toContain('dppvis-img--placeholder');
    expect(html).toContain('dppvis-text--title');
    expect(html.indexOf('dppvis-img--placeholder')).toBeLessThan(html.indexOf('dppvis-text--title')); // 图在前
  });

  it('★ Row 已在注册表与 catalog 里（注册一步到位，无需改核心）', () => {
    expect(getRegisteredTypes()).toContain('Row');
    const spec = getComponentSpec('Row');
    expect(spec?.allowsChildren).toBe(true);
    expect(spec?.maxChildren).toBeGreaterThan(0);
  });

  it('★ Row 内的 Column 仍是纵向容器（可嵌套）', () => {
    const { html } = renderToHtml(doc({
      type: 'Row',
      children: [{ type: 'Column', children: [{ type: 'Text', text: 'x' }] }],
    }));
    expect(html).toContain('dppvis-row');
    expect(html).toContain('dppvis-column');
    expect((html.match(/dppvis-column/g) ?? []).length).toBe(1);
  });

  it('负控：Row 也受深度上限约束（容器不能无限套）', () => {
    let leaf: unknown = { type: 'Text', text: 'deep' };
    for (let i = 0; i < 12; i += 1) leaf = { type: 'Row', children: [leaf] };
    const { outcome } = renderToHtml(doc(leaf));
    expect(outcome.reasons).toContain('max_depth');
  });
});
