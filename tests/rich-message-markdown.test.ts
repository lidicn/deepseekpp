import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { isExternalImageSrc, markdownImageComponent } from '../entrypoints/sidepanel/components/RichMessageContent';

function render(markdown: string, blockedLabel = '外部图片已拦截'): string {
  const components = { img: markdownImageComponent(blockedLabel) };
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { components, urlTransform: (u: string) => u }, markdown),
  );
}

describe('P1-6 拦截 Markdown 外链图片', () => {
  it('isExternalImageSrc 判定 http(s) 与协议相对为外链', () => {
    expect(isExternalImageSrc('https://evil.example/p.gif')).toBe(true);
    expect(isExternalImageSrc('http://evil.example/p.gif')).toBe(true);
    expect(isExternalImageSrc('//evil.example/p.gif')).toBe(true);
    expect(isExternalImageSrc('data:image/png;base64,AAA')).toBe(false);
    expect(isExternalImageSrc('blob:uuid')).toBe(false);
    expect(isExternalImageSrc(undefined)).toBe(false);
  });

  it('![x](https://evil...) 不渲染真 img src，且含拦截文案', () => {
    const out = render('![tracking](https://evil.example/p.gif)');
    expect(out).not.toContain('src="https://evil');
    expect(out).toContain('外部图片已拦截');
    expect(out).toContain('tracking');
  });

  it('![x](//evil...)（协议相对）同样被拦', () => {
    const out = render('![px](//evil.example/p.gif)');
    expect(out).not.toContain('//evil.example');
    expect(out).toContain('外部图片已拦截');
  });

  it('![x](data:...) 内联图正常渲染 <img src=data:...>', () => {
    const out = render('![inlined](data:image/png;base64,AAA)');
    expect(out).toContain('src="data:image/png;base64,AAA"');
    expect(out).not.toContain('外部图片已拦截');
  });

  it('普通 markdown（标题/列表/链接/代码块）渲染不受影响', () => {
    const md = '# 标题\n\n- 项目一\n- [链接](https://example.com)\n\n`code`';
    const out = render(md);
    expect(out).toContain('<h1>标题</h1>');
    expect(out).toContain('<li>项目一</li>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('<code>code</code>');
  });
});
