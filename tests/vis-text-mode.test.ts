/**
 * 正文模式守卫：模型不打 ``` 围栏、把 JSON 当正文段落时也要能出卡。
 *
 * 真机诊断（2026-10-29）：`scanned:0` 但 `turns:5` —— 页面里一个 <pre><code> 都没有，
 * 模型把 `vis-json` 写成普通文字、JSON 当段落。只认围栏就永远不出卡。
 *
 * 变异（可判红）：
 *   ① 去掉 scan() 里的正文兜底分支 ⇒ 用例 1 红；
 *   ② matchJsonEnd 忽略字符串内的花括号 ⇒ 用例 4 红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createVisInjector } from '../core/vis/inject';
import { findVisDocuments, matchJsonEnd } from '../core/vis/text-detect';

const docText = (text: string): string =>
  JSON.stringify({ v: 1, root: { type: 'Text', text, variant: 'title' } });

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-dppvis-diag');
});

function mountTurn(innerHtml: string): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'ds-markdown';
  turn.innerHTML = innerHtml;
  document.body.appendChild(turn);
  return turn;
}

function shadowOf(): ShadowRoot | null {
  const host = document.querySelector('.dppvis-host') as HTMLElement | null;
  return host?.shadowRoot ?? null;
}

describe('括号配平', () => {
  it('★ 字符串里的花括号不影响配平（变异的靶子）', () => {
    const text = '{"v":1,"root":{"type":"Text","text":"a}b{c"}}';
    const open = text.indexOf('{');
    const end = matchJsonEnd(text, open);
    expect(end).toBe(text.length - 1);
    expect(JSON.parse(text.slice(open, end + 1))).toBeTruthy();
  });

  it('★ 转义引号不破坏配平', () => {
    const text = '{"v":1,"root":{"type":"Text","text":"say \\"hi\\""}}';
    const end = matchJsonEnd(text, 0);
    expect(end).toBe(text.length - 1);
  });

  it('负控：未闭合返回 -1', () => {
    expect(matchJsonEnd('{"v":1,"root":{', 0)).toBe(-1);
  });
});

describe('findVisDocuments', () => {
  it('★ 跨元素拼接也能找到（段落被拆开时）', () => {
    const turn = mountTurn(`<p>推荐如下：</p><p>vis-json</p><p>${docText('标题A')}</p>`);
    const found = findVisDocuments(turn, 3);
    expect(found).toHaveLength(1);
    expect((found[0]?.doc as { v: number }).v).toBe(1);
  });

  it('负控：JSON 非法就不算（不误伤普通文本）', () => {
    const turn = mountTurn('<p>{"v":1,"root": 这里少了东西</p>');
    expect(findVisDocuments(turn, 3)).toHaveLength(0);
  });
});

describe('注入层 · 正文模式', () => {
  it('★ 无围栏的纯文本 JSON ⇒ 出卡，且承载它的段落被替换（不留原文）', () => {
    const turn = mountTurn(`<p>下面是推荐：</p><p>vis-json</p><p>${docText('正文模式标题')}</p>`);
    const injector = createVisInjector({ enabled: true, document });
    const rendered = injector.scan();

    expect(rendered).toBe(1);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(1);
    const shadow = shadowOf();
    expect(shadow?.querySelector('.dppvis-text--title')?.textContent).toBe('正文模式标题');
    // JSON 段落已被卡片替换
    expect(turn.textContent ?? '').not.toContain('"v":1');
    injector.dispose();
  });

  it('★ 一个回合里两张卡也能各就各位', () => {
    mountTurn(`<p>${docText('第一张')}</p><p>${docText('第二张')}</p>`);
    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(2);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(2);
    injector.dispose();
  });

  it('★ 幂等：重复扫描不重复渲染', () => {
    mountTurn(`<p>${docText('一次就好')}</p>`);
    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(1);
    expect(injector.scan()).toBe(0);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(1);
    injector.dispose();
  });

  it('★ 诊断能反映正文模式生效（textRendered）', () => {
    mountTurn(`<p>${docText('诊断')}</p>`);
    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    const diag = JSON.parse(document.documentElement.getAttribute('data-dppvis-diag') ?? '{}');
    expect(diag.scanned).toBe(0);
    expect(diag.textRendered).toBe(1);
    expect(diag.rendered).toBe(1);
    injector.dispose();
  });

  it('负控：模型正常打了围栏时，正文模式不重复接管', () => {
    const turn = document.createElement('div');
    turn.className = 'ds-markdown';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-vis-json';
    code.textContent = docText('围栏模式');
    pre.appendChild(code);
    turn.appendChild(pre);
    document.body.appendChild(turn);

    const injector = createVisInjector({ enabled: true, document });
    expect(injector.scan()).toBe(1);
    expect(injector.scan()).toBe(0);
    expect(document.querySelectorAll('.dppvis-host').length).toBe(1);
    injector.dispose();
  });
});
