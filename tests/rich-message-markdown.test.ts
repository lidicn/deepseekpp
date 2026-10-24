import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isAllowedInlineImageSrc,
  isExternalImageSrc,
  markdownImageComponent,
} from '../entrypoints/sidepanel/components/RichMessageContent';

function render(markdown: string, blockedLabel = '外部图片已拦截'): string {
  const components = { img: markdownImageComponent(blockedLabel) };
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { components, urlTransform: (u: string) => u }, markdown),
  );
}

describe('P1-6 拦截 Markdown 外链图片（B6 白名单返工）', () => {
  it('白名单谓词：data:/blob: 放行，其余一律 false', () => {
    expect(isAllowedInlineImageSrc('data:image/png;base64,AAA')).toBe(true);
    expect(isAllowedInlineImageSrc('blob:https://origin/uuid')).toBe(true);
    expect(isAllowedInlineImageSrc(undefined)).toBe(false);
    expect(isAllowedInlineImageSrc('')).toBe(false);
    expect(isAllowedInlineImageSrc('https://evil.example/p.gif')).toBe(false);
    // 旧名别名语义：非内联 = 被拦
    expect(isExternalImageSrc('https://evil.example/p.gif')).toBe(true);
    expect(isExternalImageSrc('data:image/png;base64,AAA')).toBe(false);
  });

  it('B6 绕过向量：前导 NUL（\\u0000）必须被拦', () => {
    const src = '\u0000https://evil.example/p.gif';
    // 谓词层：白名单直接判 false（不需要识别 C0 控制字符）
    expect(isAllowedInlineImageSrc(src)).toBe(false);
    // 渲染层：不出现真 img src
    const out = render(`![x](${src})`);
    expect(out).not.toContain('evil.example/p.gif');
    expect(out).toContain('外部图片已拦截');
  });

  it('B6 绕过向量：反斜杠 \\\\evil.example/p.gif 被拦', () => {
    expect(isAllowedInlineImageSrc('\\\\evil.example/p.gif')).toBe(false);
    const out = render('![x](\\\\evil.example/p.gif)');
    expect(out).toContain('外部图片已拦截');
  });

  it('B6 绕过向量：ftp:// 被拦', () => {
    expect(isAllowedInlineImageSrc('ftp://evil.example/p.gif')).toBe(false);
    const out = render('![x](ftp://evil.example/p.gif)');
    expect(out).toContain('外部图片已拦截');
  });

  it('B6 绕过向量：javascript: 被拦', () => {
    expect(isAllowedInlineImageSrc('javascript:alert(1)')).toBe(false);
  });

  it('原有判据：http(s) 与协议相对仍被拦', () => {
    expect(isAllowedInlineImageSrc('https://evil.example/p.gif')).toBe(false);
    expect(isAllowedInlineImageSrc('http://evil.example/p.gif')).toBe(false);
    expect(isAllowedInlineImageSrc('//evil.example/p.gif')).toBe(false);
  });

  it('原有判据：大写 HTTP(S) 同样被拦', () => {
    expect(isAllowedInlineImageSrc('HTTPS://evil.example/p.gif')).toBe(false);
    const out = render('![x](HTTPS://evil.example/p.gif)');
    expect(out).not.toContain('src="HTTPS://evil');
    expect(out).toContain('外部图片已拦截');
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

  it('![x](blob:...) 正常渲染', () => {
    const out = render('![b](blob:https://origin/uuid)');
    expect(out).toContain('src="blob:https://origin/uuid"');
    expect(out).not.toContain('外部图片已拦截');
  });

  it('拦截占位是纯文本 <span>，不是 <a> 外跳', () => {
    const out = render('![x](https://evil.example/p.gif)');
    expect(out).toContain('<span');
    expect(out).not.toContain('<a href="https://evil');
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
