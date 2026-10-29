/**
 * 图片通路守卫（PoC-2a：热链 + 失败兜底，零新权限）。
 *
 * 为什么不是后台代理：本扩展 host_permissions 里**没有任何图片站点**，
 * 走代理必须先扩权限（用户手势授权或商店审核）—— 那是产品决策，不是 PoC 能自裁。
 *
 * 变异（可判红）：
 *   ① 去掉 `referrerpolicy="no-referrer"` ⇒ 用例 1 红；
 *   ② 去掉 injector 里的 error 监听 ⇒ 用例 3 红（破图不会降级成渐变）。
 */
import { describe, expect, it } from 'vitest';
import { renderToHtml } from '../core/vis';
import { createVisInjector } from '../core/vis/inject';

const doc = (root: unknown): unknown => ({ v: 1, root });

const IMG_DOC = JSON.stringify({
  v: 1,
  root: {
    type: 'Row',
    children: [
      { type: 'Image', src: 'https://upload.wikimedia.org/x.jpg', alt: '海报', ratio: '2/3' },
      { type: 'Column', children: [{ type: 'Text', text: '标题' }] },
    ],
  },
});

function turnWith(code: string): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'ds-markdown';
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.className = 'language-vis-json';
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  turn.appendChild(pre);
  document.body.appendChild(turn);
  return turn;
}

describe('图片通路（热链 + 兜底）', () => {
  it('★ <img> 带 lazy/async/no-referrer（no-referrer 是绕防盗链的关键，别删）', () => {
    const { html } = renderToHtml(doc({
      type: 'Image',
      src: 'https://upload.wikimedia.org/x.jpg',
      alt: '海报',
    }));
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it('★ 只有 http(s) 才出 <img>；其它协议不出（不出网）', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://a/x.jpg', null]) {
      const { html } = renderToHtml(doc({ type: 'Image', src: bad, alt: 'x' }));
      expect(html).not.toContain('<img');
      expect(html).toContain('dppvis-img--placeholder');
    }
  });

  it('★ 加载失败时就地降级为渐变占位（不留破图）', () => {
    turnWith(IMG_DOC);
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();

    const host = document.querySelector('.dppvis-host') as HTMLElement | null;
    const shadow = host?.shadowRoot ?? null;
    const img = shadow?.querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('wikimedia');

    // 模拟图片加载失败
    img?.dispatchEvent(new Event('error'));

    expect(shadow?.querySelector('img')).toBeNull();
    const holder = shadow?.querySelector('.dppvis-img--placeholder') as HTMLElement | null;
    expect(holder).not.toBeNull();
    expect(holder?.getAttribute('aria-label')).toBe('海报');
    expect(holder?.style.getPropertyValue('--dppvis-hue')).toBe('210');
    injector.dispose();
  });

  it('负控：同一次挂载不会给同一张图重复绑监听（幂等）', () => {
    turnWith(IMG_DOC);
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    injector.scan();
    const host = document.querySelector('.dppvis-host') as HTMLElement | null;
    const img = host?.shadowRoot?.querySelector('img') as HTMLImageElement | null;
    expect(img?.dataset.dppvisFallbackBound).toBe('1');
    injector.dispose();
  });
});
