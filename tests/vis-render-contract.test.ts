/**
 * S3/S4 守卫：渲染契约（版本协商 / 三级降级 / 双出口一致性 / XSS 不变量）。
 *
 * S4 口径说明：原计划是「renderToFragment 零 innerHTML」。
 * 实际改为**单一真源（HTML 字符串）+ 不变量测试**：
 *   · DOM 直构要把三个组件逻辑再写一遍 ⇒ 两条出口必然漂移（评审 I3 那类缺陷）；
 *   · renderToFragment 的 innerHTML 输入**只来自 renderToHtml 的输出**，
 *     而该输出的每个可变部分都必须过 escapeHtml —— 这个不变量由本文件最后三条用例钉住。
 * 变异（可判红）：
 *   ① 去掉 render.ts 的版本校验 ⇒ 用例 1 红；
 *   ② escapeHtml 里去掉 `<` 的转义 ⇒ XSS 用例红。
 */
import { describe, expect, it } from 'vitest';
import { renderToFragment, renderToHtml } from '../core/vis';

const docWith = (root: unknown, v: unknown = 1): unknown => ({ v, root });

describe('S3 版本协商', () => {
  it('★ 未知版本 ⇒ failed 且不出 HTML（交给上层保留原文）', () => {
    const { html, outcome } = renderToHtml(docWith({ type: 'Text', text: 'x' }, 2));
    expect(html).toBe('');
    expect(outcome.status).toBe('failed');
    expect(outcome.reasons).toContain('unsupported_version:2');
  });

  it('★ 缺失版本同样 failed（不猜）', () => {
    const { html, outcome } = renderToHtml({ root: { type: 'Text', text: 'x' } });
    expect(html).toBe('');
    expect(outcome.status).toBe('failed');
    expect(outcome.reasons).toContain('unsupported_version:undefined');
  });

  it('负控：v=1 正常渲染', () => {
    const { html, outcome } = renderToHtml(docWith({ type: 'Text', text: 'ok' }));
    expect(html).toContain('dppvis-root');
    expect(html).toContain('ok');
    expect(outcome.status).toBe('ok');
  });
});

describe('S3 三级降级', () => {
  it('★ L1 局部降级：未知 type ⇒ degraded 但仍出卡，并保留可读标题', () => {
    const { html, outcome } = renderToHtml(docWith({ type: 'Mystery', title: '神秘卡片' }));
    expect(outcome.status).toBe('degraded');
    expect(html).not.toBe('');
    expect(html).toContain('神秘卡片');
    expect(html).toContain('dppvis-text--meta');
    expect(outcome.reasons.some((r) => r.startsWith('unknown_type:'))).toBe(true);
  });

  it('★ L2 结构失败：空文档 ⇒ failed 不出 HTML（不是"空白卡片"）', () => {
    const { html, outcome } = renderToHtml(docWith(undefined));
    expect(html).toBe('');
    expect(outcome.status).toBe('failed');
  });

  it('★ 上限：深度超限记降级原因，且不抛异常', () => {
    let leaf: unknown = { type: 'Text', text: 'deep' };
    for (let i = 0; i < 12; i += 1) leaf = { type: 'Column', children: [leaf] };
    const { html, outcome } = renderToHtml(docWith(leaf));
    expect(outcome.status).toBe('degraded');
    expect(outcome.reasons).toContain('max_depth');
    expect(html).toContain('dppvis-root');
  });
});

describe('S4 双出口一致性 + XSS 不变量', () => {
  const sample = docWith({
    type: 'Column',
    children: [
      { type: 'Image', src: null, alt: '海报', ratio: '2/3', fallback: { hue: 28 } },
      { type: 'Text', text: '标题', variant: 'title' },
      { type: 'Text', text: '正文 & <scripts>', variant: 'body' },
    ],
  });

  it('★ 同一文档：HTML 出口与 Fragment 出口的可读文本一致', () => {
    const { html } = renderToHtml(sample);
    const { fragment } = renderToFragment(sample, document);
    const host = document.createElement('div');
    host.appendChild(fragment);
    const norm = (value: string | null) => (value ?? '').replace(/\s+/g, '');
    // 两侧都解析成 DOM 再比「可读文本」：HTML 面是转义串，不能直接和 textContent 比
    const hostFromHtml = document.createElement('div');
    hostFromHtml.innerHTML = html;
    expect(norm(host.textContent)).toBe(norm(hostFromHtml.textContent));
    expect(norm(host.textContent)).toContain('海报');
    expect(norm(host.textContent)).toContain('正文');
  });

  it('★ XSS：模型文本里的标签/属性注入在两条出口都不成立（看 DOM，不看字符串）', () => {
    const evil = docWith({ type: 'Text', text: '<img src=x onerror=alert(1)>"><svg onload=alert(1)>' });
    const { html } = renderToHtml(evil);
    const { fragment } = renderToFragment(evil, document);
    const host = document.createElement('div');
    host.appendChild(fragment);

    // 字符串面：不允许出现真正的标签开头
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg/i);

    // DOM 面：解析后不得有这些元素，也不得有任何 on* 属性
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();
    for (const el of [...host.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
    // 内容不吞：转义后的原文仍作为文本可见
    expect(host.textContent ?? '').toContain('onerror=alert(1)');
  });

  it('★ XSS：Image 的 javascript: 协议被解析器拒绝，走渐变占位', () => {
    const { html } = renderToHtml(docWith({
      type: 'Image',
      src: 'javascript:alert(1)',
      alt: '<b>x</b>',
      fallback: { hue: 999 },
    }));
    expect(html).not.toContain('javascript:');
    expect(html).toContain('dppvis-img--placeholder');
    expect(html).toContain('--dppvis-hue:360');   // 999 被夹紧
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
