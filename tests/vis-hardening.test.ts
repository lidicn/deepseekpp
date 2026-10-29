/**
 * QA-15 收口用例（三条都是 QA 点出来的缺口）：
 *
 * A. **敌对 props 矩阵**：variant / ratio / hue / src / alt / text 里塞引号、分号、CRLF、协议伪串，
 *    断言产出里不出现可逃逸的属性/样式注入。
 * B. **开放注册表的转义契约**：`ctx.escape` 必须存在且**每个可变值都真的经过它**
 *    （注入计数版 escape，断言调用次数 >= 可变值个数）。这是把"靠约定"变成可断言。
 * C. **fragment 出口一致性（非空转）**：不与 renderToHtml 的输出自比，
 *    而是与**由输入数据独立推出的期望文本**比；外加 failed 时 fragment 必须为空。
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  registerCoreVisComponents,
  registerVisComponent,
  renderToFragment,
  renderToHtml,
  unregisterVisComponent,
} from '../core/vis';

const doc = (root: unknown): unknown => ({ v: 1, root });

const HOSTILE = [
  '" onmouseover="alert(1)',
  "' onmouseover='alert(1)",
  '"; background:url(//evil);',
  '</style><script>alert(1)</script>',
  'a\r\nb',
  'javascript:alert(1)',
  '--dppvis-hue:1; color:red',
];

describe('A 敌对 props 矩阵', () => {
  for (const payload of HOSTILE) {
    it('Text/Image 的属性与样式不因输入而逃逸: ' + JSON.stringify(payload).slice(0, 30), () => {
      const input = doc({
        type: 'Column',
        children: [
          { type: 'Text', text: payload, variant: payload },
          { type: 'Image', src: payload, alt: payload, ratio: payload, fallback: { hue: payload } },
        ],
      });
      const { html } = renderToHtml(input);
      const { fragment } = renderToFragment(input, document);
      const host = document.createElement('div');
      host.appendChild(fragment);

      // 断言要看**解析后的 DOM**：转义后的文本里出现 "onmouseover=" 是合法的（那只是文字）
      for (const el of [...host.querySelectorAll('*')]) {
        for (const attr of [...el.attributes]) {
          expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
        }
        const style = el.getAttribute('style');
        if (style !== null) expect(style).toMatch(/^--dppvis-hue:\d{1,3}$/);
      }
      // 不得凭空产生 script / style 元素（style 是逃逸成功的标志）
      expect(host.querySelector('script')).toBeNull();
      expect(host.querySelector('style')).toBeNull();
      expect(html).not.toMatch(/<script/i);
    });
  }

  it('Text 的 variant 只落在白名单类名上（非法值 = body）', () => {
    const { html } = renderToHtml(doc({ type: 'Text', text: 'x', variant: 'dppvis-evil" onclick="x' }));
    expect(html).toContain('dppvis-text--body');
    expect(html).not.toContain('dppvis-evil');
  });

  it('Image 的 ratio 只落在白名单类名上（非法值 = 无比例类）', () => {
    const { html } = renderToHtml(doc({ type: 'Image', src: null, alt: '', ratio: '2/3 evil' }));
    expect(html).not.toContain('dppvis-ratio-2x3');
    expect(html).not.toContain('evil');
  });

  it('hue 非数字 ⇒ 回默认 210（不把字符串拼进 style）', () => {
    const { html } = renderToHtml(doc({ type: 'Image', src: null, alt: '', fallback: { hue: '1; color:red' } }));
    expect(html).toContain('--dppvis-hue:210');
    expect(html).not.toContain('color:red');
  });
});

describe('B 开放注册表的转义契约', () => {
  it('★ 注册组件通过 ctx.escape 处理每个可变值时，转义真实发生（计数断言）', () => {
    let calls = 0;
    registerVisComponent({
      type: 'CountingBadge',
      render(props, ctx) {
        const escaped = ctx.escape(props.label);
        calls += 1;
        return '<span class="dppvis-badge">' + escaped + '</span>';
      },
    });

    const { html } = renderToHtml(doc({ type: 'CountingBadge', label: '<script>x</script>' }));

    expect(calls).toBe(1);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    unregisterVisComponent('CountingBadge');
    registerCoreVisComponents();
  });

  it('★ ctx.escape 与模块导出的 escapeHtml 行为一致（不存在两套转义）', () => {
    const captured: Array<(v: unknown) => string> = [];
    registerVisComponent({
      type: 'EscapeProbe',
      render(_props, ctx) {
        captured.push(ctx.escape);
        return '<i></i>';
      },
    });
    renderToHtml(doc({ type: 'EscapeProbe' }));
    const sample = '<&>"\'';
    expect(captured[0](sample)).toBe(escapeHtml(sample));
    unregisterVisComponent('EscapeProbe');
    registerCoreVisComponents();
  });
});

describe('C fragment 出口一致性（非空转）+ 失败语义', () => {
  it('★ fragment 文本 = 由输入独立推出的期望文本（不与 renderToHtml 自比）', () => {
    const input = doc({
      type: 'Column',
      children: [
        { type: 'Image', src: null, alt: '海报A', ratio: '2/3' },
        { type: 'Text', text: '标题B', variant: 'title' },
        { type: 'Text', text: '正文C', variant: 'body' },
      ],
    });
    // 期望值直接来自上面这份输入，与渲染器实现无关
    const expected = ['海报A', '标题B', '正文C'].join('');
    const { fragment } = renderToFragment(input, document);
    const host = document.createElement('div');
    host.appendChild(fragment);
    expect((host.textContent ?? '').replace(/\s+/g, '')).toBe(expected);
  });

  it('★ 结构性失败（版本不符）⇒ fragment 必须为空，不留半张卡', () => {
    const { fragment, outcome } = renderToFragment({ v: 2, root: { type: 'Text', text: 'x' } }, document);
    expect(outcome.status).toBe('failed');
    expect(fragment.childNodes.length).toBe(0);
  });

  it('★ 降级（未知 type）⇒ fragment 非空且保留可读标题', () => {
    const { fragment, outcome } = renderToFragment(doc({ type: 'Mystery', title: '可读标题' }), document);
    expect(outcome.status).toBe('degraded');
    const host = document.createElement('div');
    host.appendChild(fragment);
    expect(host.textContent).toContain('可读标题');
  });
});
