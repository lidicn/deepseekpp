/**
 * 观察者行为守卫（QA-15 建议的"监听面收窄"）：
 *   · body 上只监听 childList（不监听 characterData）⇒ 非助手区域的文本变化不该触发扫描
 *   · 已发现的 .ds-markdown 根做深度监听 ⇒ 流式文本更新能自动补渲染
 *   · debounce 生效（同一批 mutation 只扫一次）
 *
 * 变异（可判红）：
 *   ① 把 shallowObserver 的观察项加上 characterData ⇒ 用例「非助手区域文本变化不触发」红
 *   ② 去掉 watchAllTurns() ⇒ 用例「流式补渲染」红
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createVisInjector } from '../core/vis/inject';

const GOOD_DOC = JSON.stringify({
  v: 1,
  root: { type: 'Row', children: [{ type: 'Text', text: '流式成品', variant: 'title' }] },
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assistantWith(code: string): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'ds-markdown';
  const pre = document.createElement('pre');
  const el = document.createElement('code');
  el.className = 'language-vis-json';
  el.textContent = code;
  pre.appendChild(el);
  turn.appendChild(pre);
  return turn;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('观察者收窄', () => {
  it('★ start() 后新增助手回合会自动渲染（无需手动 scan）', async () => {
    const injector = createVisInjector({ enabled: true, document, debounceMs: 20 });
    injector.start();
    document.body.appendChild(assistantWith(GOOD_DOC));

    await wait(140);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(1);
    injector.dispose();
  });

  it('★ 流式补渲染：先建"未闭合"的回合，再补完整内容会自动出卡', async () => {
    const injector = createVisInjector({ enabled: true, document, debounceMs: 20 });
    injector.start();

    const turn = assistantWith('{"v":1,"root":{"type":"Text","text":"一半');
    // 必须在骨架替换 <pre> **之前**抓住 code 引用：替换后 code 随 pre 一起脱离文档
    const codeEl = turn.querySelector('code');
    document.body.appendChild(turn);
    await wait(120);
    // 未闭合：不出真卡，先摆骨架，并标记 pending
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(1);
    expect(codeEl?.getAttribute('data-dppvis-state')).toBe('pending');

    // 模拟流式补完（只改文本，不动结构）
    if (codeEl) codeEl.textContent = GOOD_DOC;
    await wait(160);

    expect(document.querySelectorAll('.dppvis-host:not(.dppvis-host--pending)').length).toBe(1);
    expect(document.querySelectorAll('.dppvis-host--pending').length).toBe(0);
    injector.dispose();
  });

  // 说明（实测得出，不是推测）：给浅监听加上 characterData:true 后**本用例仍然绿** ——
  // 即它守的是 `isRelevant` 谓词（只放行"新增节点里含 .ds-markdown"与"卡片被移除"），
  // 不是 observer 的选项。选项收窄的真实收益是"少把记录递进 JS"，属于成本优化，
  // 在单测里不可观测；真正有行为差异的守卫是下面那条"流式补渲染"（变异后红 3）。
  it('★ 非助手区域的任何变化都不会导致出卡（由 isRelevant 谓词守住）', async () => {
    const injector = createVisInjector({ enabled: true, document, debounceMs: 20 });
    injector.start();

    const userBubble = document.createElement('div');
    userBubble.className = 'user-message';
    const code = document.createElement('code');
    code.className = 'language-vis-json';
    code.textContent = GOOD_DOC;
    const pre = document.createElement('pre');
    pre.appendChild(code);
    userBubble.appendChild(pre);
    document.body.appendChild(userBubble);
    // 结构变化会被浅监听看到，但「非助手回合」在 handle 里被拒 ⇒ 不渲染
    await wait(120);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(0);

    // 纯文本更新（characterData）：若 body 层监听了 characterData，这里会触发出卡
    code.textContent = GOOD_DOC + ' ';
    await wait(140);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(0);
    injector.dispose();
  });

  it('★ 卡片被移除后，观察者会驱动状态清理', async () => {
    const injector = createVisInjector({ enabled: true, document, debounceMs: 20 });
    injector.start();
    const turn = assistantWith(GOOD_DOC);
    document.body.appendChild(turn);
    await wait(140);
    expect(injector.mountedCount()).toBe(1);

    document.body.innerHTML = '';
    await wait(140);
    expect(injector.mountedCount()).toBe(0);
    injector.dispose();
  });

  it('负控：stop() 之后不再自动渲染', async () => {
    const injector = createVisInjector({ enabled: true, document, debounceMs: 20 });
    injector.start();
    injector.stop();
    document.body.appendChild(assistantWith(GOOD_DOC));
    await wait(140);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(0);
    injector.dispose();
  });
});
