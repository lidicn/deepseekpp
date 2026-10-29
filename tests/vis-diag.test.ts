/**
 * 诊断出口守卫：`<html data-dppvis-diag>` 必须如实反映「看见了什么」。
 * 这是排查"卡片为什么没出现"的唯一依据，不能失真。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createVisInjector } from '../core/vis/inject';

const GOOD = JSON.stringify({ v: 1, root: { type: 'Text', text: 'x' } });

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-dppvis-diag');
});

function readDiag(): { scanned: number; sawFence: number; inTurn: number; rendered: number; turns: number } | null {
  const raw = document.documentElement.getAttribute('data-dppvis-diag');
  if (!raw) return null;
  return JSON.parse(raw) as { scanned: number; sawFence: number; inTurn: number; rendered: number; turns: number };
}

function mount(code: string, cls: string, inTurn: boolean): void {
  const holder = document.createElement(inTurn ? 'div' : 'div');
  holder.className = inTurn ? 'ds-markdown' : 'user-message';
  const pre = document.createElement('pre');
  const el = document.createElement('code');
  el.className = cls;
  el.textContent = code;
  pre.appendChild(el);
  holder.appendChild(pre);
  document.body.appendChild(holder);
}

describe('诊断快照', () => {
  it('★ 助手回合里的合法围栏：scanned/sawFence/inTurn/rendered 都对', () => {
    mount(GOOD, 'language-vis-json', true);
    createVisInjector({ enabled: true, document }).scan();
    const diag = readDiag();
    expect(diag).not.toBeNull();
    expect(diag?.scanned).toBe(1);
    expect(diag?.sawFence).toBe(1);
    expect(diag?.inTurn).toBe(1);
    expect(diag?.rendered).toBe(1);
    expect(diag?.turns).toBe(1);
  });

  it('★ 能区分三种失败：不在回合内 / 判据没命中 / 版本不符', () => {
    // 不在助手回合
    mount(GOOD, 'language-vis-json', false);
    let injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(readDiag()).toMatchObject({ scanned: 1, sawFence: 1, inTurn: 0, rendered: 0 });
    injector.dispose();
    document.body.innerHTML = '';

    // 判据没命中（类名不含 vis-json 且内容不像 vis-json）
    mount('plain text', 'language-text', true);
    injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(readDiag()).toMatchObject({ scanned: 1, sawFence: 0, inTurn: 0, rendered: 0 });
    injector.dispose();
    document.body.innerHTML = '';

    // 判据命中但版本不符（渲染被拒，代码块保留）
    mount(JSON.stringify({ v: 9, root: { type: 'Text', text: 'x' } }), 'language-vis-json', true);
    injector = createVisInjector({ enabled: true, document });
    injector.scan();
    expect(readDiag()).toMatchObject({ sawFence: 1, inTurn: 1, rendered: 0 });
    expect(document.querySelector('pre')).not.toBeNull();
    injector.dispose();
  });

  it('负控：flag 关闭时不写诊断（不往页面塞东西）', () => {
    mount(GOOD, 'language-vis-json', true);
    const injector = createVisInjector({ enabled: false, document });
    injector.scan();
    expect(readDiag()).toBeNull();
    injector.dispose();
  });
});
