/**
 * S7 守卫：注入层（只在助手回合、双判据、失败保留原文、幂等、可回收、flag 关闭无副作用）。
 *
 * 变异（可判红）：
 *   ① 去掉 `inAssistantTurn` ⇒ 用例"不劫持用户消息"红；
 *   ② 去掉 `failed` 保留分支 ⇒ 用例"版本不符保留原代码块"红；
 *   ③ 去掉 `mounted` 幂等判断 ⇒ 用例"重复扫描只挂一次"红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createVisInjector } from '../core/vis/inject';
import type { RenderOutcome } from '../core/vis';

const GOOD_DOC = JSON.stringify({
  v: 1,
  root: {
    type: 'Column',
    children: [
      { type: 'Image', src: null, alt: '海报', ratio: '2/3', fallback: { hue: 28 } },
      { type: 'Text', text: '肖申克的救赎', variant: 'title' },
    ],
  },
});

function mountAssistant(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'ds-markdown';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function fence(code: string, className = 'language-vis-json'): string {
  return `<pre><code class="${className}">${code}</code></pre>`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('S7 注入层', () => {
  it('★ 助手回合里的 vis-json 围栏被渲染成卡片，原 pre 被替换', () => {
    mountAssistant(fence(GOOD_DOC));
    const injector = createVisInjector({ enabled: true, document });

    expect(injector.scan()).toBe(1);
    expect(injector.mountedCount()).toBe(1);
    expect(document.querySelector('pre')).toBeNull();

    const host = document.querySelector('.dppvis-host') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.shadowRoot?.querySelector('.dppvis-text--title')?.textContent).toContain('肖申克的救赎');
    // 样式隔离：CSS 进了 shadow，而不是 document.head
    expect(document.head.querySelector('style')?.textContent ?? '').not.toContain('dppvis-text--title');
    expect(host.shadowRoot?.querySelector('style')?.textContent).toContain('dppvis-text--title');
    injector.dispose();
  });

  it('★ 双判据：没有 class 但内容像 vis-json 也能命中', () => {
    mountAssistant(fence(GOOD_DOC, 'language-json'));
    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(1);
    injector.dispose();
  });

  it('★ 失败保留原文：v=2 不渲染，代码块保持可见', () => {
    const badDoc = JSON.stringify({ v: 2, root: { type: 'Text', text: 'x' } });
    mountAssistant(fence(badDoc));
    const outcomes: RenderOutcome[] = [];
    const injector = createVisInjector({
      enabled: true,
      document,
      onOutcome: (o) => outcomes.push(o),
    });

    expect(injector.scan()).toBe(0);
    expect(document.querySelector('pre')).not.toBeNull();      // 未被替换
    expect(document.querySelector('.dppvis-host')).toBeNull();  // 没出空白卡
    expect(outcomes[0]?.status).toBe('failed');
    injector.dispose();
  });

  it('★ 不劫持用户消息：非 .ds-markdown 容器内的围栏一律不动', () => {
    const userBubble = document.createElement('div');
    userBubble.className = 'user-message';
    userBubble.innerHTML = fence(GOOD_DOC);
    document.body.appendChild(userBubble);

    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(0);
    expect(document.querySelector('pre')).not.toBeNull();
    injector.dispose();
  });

  it('★ 幂等：同一节点重复扫描只挂一张卡', () => {
    mountAssistant(fence(GOOD_DOC));
    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(1);
    expect(injector.scan()).toBe(0);
    expect(injector.mountedCount()).toBe(1);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(1);
    injector.dispose();
  });

  it('★ 流式未闭合：不处理，等下一次扫描', () => {
    mountAssistant(fence('{"v":1,"root":{"type":"Text","text":"写到一半'));
    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(0);
    expect(document.querySelector('pre')).not.toBeNull();
    injector.dispose();
  });

  it('★ 回收：卡片被移除后内部状态同步清理（不泄漏）', () => {
    mountAssistant(fence(GOOD_DOC));
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(injector.mountedCount()).toBe(1);

    document.body.innerHTML = '';   // 模拟框架重建节点
    injector.scan();
    expect(injector.mountedCount()).toBe(0);
    injector.dispose();
  });

  it('★ flag 关闭：start()/scan() 完全不碰 DOM', () => {
    mountAssistant(fence(GOOD_DOC));
    const before = document.body.innerHTML;
    const injector = createVisInjector({ enabled: false, document });
    injector.start();
    expect(injector.scan()).toBe(0);
    expect(injector.mountedCount()).toBe(0);
    expect(document.body.innerHTML).toBe(before);
    injector.stop();
    injector.dispose();
  });

  it('负控：非法 JSON 保留原文并标记，不抛异常', () => {
    mountAssistant(fence('{not json'));
    const injector = createVisInjector({ enabled: true, document });
    expect(() => injector.scan()).not.toThrow();
    expect(document.querySelector('pre')).not.toBeNull();
    injector.dispose();
  });
});
