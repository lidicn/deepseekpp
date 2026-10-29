/**
 * S2 守卫：注册表必须是**开放**的 ——
 * 加一个组件只需「新增 components/*.ts + 一行 registerVisComponent」，
 * 不改 catalog.ts / registry.ts / render.ts。
 *
 * 变异（可判红）：
 *   ① 把 registry.renderVisNode 改回「只认 Text/Image/Column 的 if-else」⇒ 用例 1 红；
 *   ② 去掉 try/catch ⇒ 用例 3 红（组件抛错会击穿整张卡）。
 */
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeHtml,
  getRegisteredTypes,
  registerCoreVisComponents,
  registerVisComponent,
  renderToHtml,
  resetVisRegistryForTests,
  unregisterVisComponent,
} from '../core/vis';

afterEach(() => {
  unregisterVisComponent('TestBadge');
  unregisterVisComponent('Exploding');
  unregisterVisComponent('TestStack');
  resetVisRegistryForTests();
  registerCoreVisComponents();
});

const docWith = (root: unknown): unknown => ({ v: 1, root });

describe('S2 组件注册表（开放扩展）', () => {
  it('★ 新增组件只注册即可被 renderToHtml 渲染，且走同一条转义链', () => {
    registerVisComponent({
      type: 'TestBadge',
      render(props) {
        return `<span class="dppvis-badge">${escapeHtml(props.label)}</span>`;
      },
    });

    const { html, outcome } = renderToHtml(docWith({ type: 'TestBadge', label: '<b>x</b>' }));

    expect(html).toContain('dppvis-badge');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');   // 转义生效
    expect(html).not.toContain('<b>x</b>');           // 原文未泄漏
    expect(outcome.status).toBe('ok');
    expect(getRegisteredTypes()).toContain('TestBadge');
  });

  it('★ 注册为容器的组件能渲染 children（allowsChildren/maxChildren 由组件自带）', () => {
    registerVisComponent({
      type: 'TestStack',
      allowsChildren: true,
      maxChildren: 2,
      render(props, ctx) {
        const kids = Array.isArray(props.children) ? props.children : [];
        return `<div class="dppvis-teststack">${kids
          .map((child) => `<i>${escapeHtml((child as { label?: string })?.label ?? '')}</i>`)
          .join('')}</div>`;
      },
    });

    const { html, outcome } = renderToHtml(docWith({
      type: 'TestStack',
      children: [{ type: 'TestBadge', label: 'a' }, { label: 'b' }, { label: 'c' }],
    }));

    expect(html).toContain('dppvis-teststack');
    expect(html).toContain('<i>a</i>');
    // maxChildren=2 ⇒ 第三个被截断并记降级原因
    expect(html).not.toContain('<i>c</i>');
    expect(outcome.reasons).toContain('max_children');
    void ctxUnused;
  });

  it('★ 组件抛错不击穿整张卡：该子树降级、兄弟节点照常渲染', () => {
    registerVisComponent({
      type: 'Exploding',
      render() {
        throw new Error('boom');
      },
    });

    const { html, outcome } = renderToHtml(docWith({
      type: 'Column',
      children: [
        { type: 'Text', text: 'before' },
        { type: 'Exploding', title: '炸了' },
        { type: 'Text', text: 'after' },
      ],
    }));

    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).toContain('炸了');                       // 降级成可读文本
    expect(outcome.status).toBe('degraded');
    expect(outcome.reasons).toContain('component_threw:Exploding');
  });

  it('负控：注销后该 type 不再被识别（防止注册表只增不减）', () => {
    registerVisComponent({ type: 'TestBadge', render: () => '<i></i>' });
    expect(getRegisteredTypes()).toContain('TestBadge');
    unregisterVisComponent('TestBadge');
    expect(getRegisteredTypes()).not.toContain('TestBadge');

    const { outcome } = renderToHtml(docWith({ type: 'TestBadge', label: 'x' }));
    expect(outcome.reasons.some((r) => r.startsWith('unknown_type:'))).toBe(true);
  });

  it('负控：清空注册表后核心组件需重新注册（防"隐式全局状态"）', () => {
    resetVisRegistryForTests();
    expect(getRegisteredTypes()).toEqual([]);
    registerCoreVisComponents();
    expect(getRegisteredTypes().length).toBe(3);
  });
});

const ctxUnused = undefined;
