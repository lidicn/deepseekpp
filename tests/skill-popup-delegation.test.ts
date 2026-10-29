/**
 * Skill Popup 事件委托守卫。
 *
 * 背景（2026-10-29 真机故障）：`/` 弹窗"成功过一次后永久失灵"。
 * 根因：监听绑在**当时那个 textarea** 上；DeepSeek 是 SPA，换会话会把 composer
 * 在 #root 内部重建，而 #95 把观察器从 subtree 砍成 body 直接子元素后，
 * 重建不再被观察到 ⇒ textarea 变成游离节点 ⇒ input 监听随之失效。
 *
 * 修法：改用 document 上的 input 捕获（事件委托），不再持有元素引用。
 *
 * 变异（可判红）：
 *   ① 把 `document.addEventListener('input', onInputCapture, true)` 换回
 *      "绑到具体 textarea 的 input 监听" ⇒ 用例 1 红；
 *   ② 恢复"空列表直接 hidePopup" ⇒ 用例 2 红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { initSkillPopup, stopSkillPopup } from '../core/ui/skill-popup';

const SKILLS = [
  { name: 'movie-cards', description: '影视卡片' },
  { name: 'shell', description: '本地命令' },
];

afterEach(() => {
  stopSkillPopup();
  document.body.innerHTML = '';
});

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function popup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-dpp-skill-popup]');
}

describe('Skill Popup · 事件委托', () => {
  it('★ composer 被整体替换后仍然能弹（旧实现此例必红）', () => {
    initSkillPopup(SKILLS);

    const first = document.createElement('textarea');
    first.id = 'chat-input';
    document.body.appendChild(first);
    typeInto(first, '/');
    expect(popup()?.style.display).toBe('block');
    expect(popup()?.querySelectorAll('.dpp-skill-item').length).toBe(2);

    // 模拟 SPA 重建 composer：旧节点被移除，新节点插在同一位置
    first.remove();
    const second = document.createElement('textarea');
    second.id = 'chat-input';
    document.body.appendChild(second);

    typeInto(second, '/mo');

    expect(popup()?.style.display).toBe('block');
    const items = [...(popup()?.querySelectorAll('.dpp-skill-item') ?? [])];
    expect(items.length).toBe(1);
    expect(items[0]?.textContent ?? '').toContain('movie-cards');
  });

  it('★ 技能列表为空时给出提示，而不是静默什么都不发生', () => {
    initSkillPopup([]);

    const el = document.createElement('textarea');
    el.id = 'chat-input';
    document.body.appendChild(el);
    typeInto(el, '/');

    expect(popup()?.style.display).toBe('block');
    expect(popup()?.querySelector('.dpp-skill-empty')).not.toBeNull();
    // 空提示不可选：没有任何候选项
    expect(popup()?.querySelectorAll('.dpp-skill-item').length).toBe(0);
  });

  it('★ 诊断钩子能回答"哪一环断了"', () => {
    initSkillPopup(SKILLS);
    const el = document.createElement('textarea');
    el.id = 'chat-input';
    document.body.appendChild(el);

    const diag = (window as unknown as { __dppSkillPopup?: () => Record<string, unknown> }).__dppSkillPopup;
    expect(typeof diag).toBe('function');
    const state = diag?.() ?? {};
    expect(state.initialized).toBe(true);
    expect(state.hasCss).toBe(true);
    expect(state.skills).toBe(2);
    expect(state.textareaConnected).toBe(true);
  });

  it('负控：输入不带 / 或含空格时不弹', () => {
    initSkillPopup(SKILLS);
    const el = document.createElement('textarea');
    el.id = 'chat-input';
    document.body.appendChild(el);

    typeInto(el, 'hello');
    expect(popup()?.style.display ?? 'none').not.toBe('block');

    typeInto(el, '/movie cards');
    expect(popup()?.style.display ?? 'none').not.toBe('block');
  });

  it('负控：stop 之后监听与样式都清掉，诊断钩子消失', () => {
    initSkillPopup(SKILLS);
    const el = document.createElement('textarea');
    el.id = 'chat-input';
    document.body.appendChild(el);
    typeInto(el, '/');
    expect(popup()).not.toBeNull();

    stopSkillPopup();

    expect(document.getElementById('dpp-skill-popup-css')).toBeNull();
    expect(document.querySelector('[data-dpp-skill-popup]')).toBeNull();
    expect((window as unknown as { __dppSkillPopup?: unknown }).__dppSkillPopup).toBeUndefined();

    // 再打字也不该有反应（监听已移除）
    typeInto(el, '/');
    expect(document.querySelector('[data-dpp-skill-popup]')).toBeNull();
  });
});
