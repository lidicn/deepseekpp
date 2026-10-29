/**
 * 流式三态守卫：pending 骨架 → 完整卡 → 失败还原原始代码块。
 *
 * 变异（可判红）：
 *   ① `markPending` 里不摆骨架（直接 return）⇒ 用例 1 红；
 *   ② `resolvePending` 失败分支不还原 ⇒ 用例 3 红（原文丢失，只剩骨架）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createVisInjector } from '../core/vis/inject';

const GOOD = JSON.stringify({
  v: 1,
  root: {
    type: 'Row',
    children: [
      { type: 'Image', src: null, alt: '海报', ratio: '2/3', fallback: { hue: 208 } },
      { type: 'Column', children: [{ type: 'Text', text: '成品标题', variant: 'title' }] },
    ],
  },
});

function makeTurn(codeTextValue: string): { turn: HTMLElement; code: HTMLElement } {
  const turn = document.createElement('div');
  turn.className = 'ds-markdown';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-vis-json';
  code.textContent = codeTextValue;
  pre.appendChild(code);
  turn.appendChild(pre);
  document.body.appendChild(turn);
  return { turn, code };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('流式三态', () => {
  it('★ 未闭合 ⇒ 先摆骨架卡（裸 JSON 不再展示给用户）', () => {
    const { code } = makeTurn('{"v":1,"root":{"type":"Text","text":"写到一半');
    const injector = createVisInjector({ enabled: true, document });

    expect(injector.scan()).toBe(0);
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(1);
    expect(injector.pendingCount()).toBe(1);
    expect(code.getAttribute('data-dppvis-state')).toBe('pending');
    // <pre> 仍在 DOM 里（否则流式更新会失联），只是被隐藏
    const pre = document.querySelector('pre') as HTMLElement | null;
    expect(pre).not.toBeNull();
    expect(pre?.style.display).toBe('none');
    injector.dispose();
  });

  it('★ 闭合后骨架换成真卡，骨架不残留', () => {
    const { code } = makeTurn('{"v":1,"root":{"type":"Text","text":"一半');
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(injector.pendingCount()).toBe(1);

    code.textContent = GOOD;
    const rendered = injector.scan();

    expect(rendered).toBe(1);
    expect(injector.pendingCount()).toBe(0);
    expect(injector.mountedCount()).toBe(1);
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(0);
    const host = document.querySelector('.dppvis-host:not(.dppvis-host--pending)') as HTMLElement | null;
    expect(host?.shadowRoot?.querySelector('.dppvis-text--title')?.textContent).toBe('成品标题');
    injector.dispose();
  });

  it('★ 结构性失败 ⇒ 还原原始代码块（原文可见，不留骨架）', () => {
    const { code } = makeTurn('{"v":1,"root":');
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(injector.pendingCount()).toBe(1);

    // 闭合了但版本不对
    code.textContent = JSON.stringify({ v: 2, root: { type: 'Text', text: 'x' } });
    const rendered = injector.scan();

    expect(rendered).toBe(0);
    expect(injector.pendingCount()).toBe(0);
    expect(injector.mountedCount()).toBe(0);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(0);
    // 原文回来了（<pre> 重新显示）
    const pre = document.querySelector('pre') as HTMLElement | null;
    expect(pre).not.toBeNull();
    expect(pre?.style.display).toBe('');
    expect(document.body.textContent ?? '').toContain('"v":2');
    injector.dispose();
  });

  it('★ 幂等：多次扫描不重复摆骨架', () => {
    makeTurn('{"v":1,"root":{"type":"Text"');
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    injector.scan();
    injector.scan();
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(1);
    expect(injector.pendingCount()).toBe(1);
    injector.dispose();
  });

  it('负控：关掉 showPendingSkeleton ⇒ 未闭合时保持原始代码块', () => {
    const { code } = makeTurn('{"v":1,"root":{"type":"Text"');
    const injector = createVisInjector({ enabled: true, document, showPendingSkeleton: false });
    injector.scan();
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(0);
    expect(document.querySelector('pre')).not.toBeNull();
    expect(code.getAttribute('data-dppvis-state')).toBe('pending');
    injector.dispose();
  });

  it('★ 骨架也走样式隔离（CSS 在 shadow 内，且骨架类名有定义）', () => {
    makeTurn('{"v":1,"root":{"type":"Text"');
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    const host = document.querySelector('.dppvis-host--pending') as HTMLElement | null;
    const css = host?.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(css).toContain('.dppvis-skeleton');
    expect(css).toContain('prefers-reduced-motion');
    injector.dispose();
  });
});
