import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isAllowedInlineImageSrc,
  isExternalImageSrc,
  markdownImageComponent,
  previewUrlTransform,
} from '../entrypoints/sidepanel/components/RichMessageContent';

function render(markdown: string, blockedLabel = '外部图片已拦截'): string {
  const components = { img: markdownImageComponent(blockedLabel) };
  // 用**真实的** transform，不能再用恒等 —— 恒等会掩盖「链接协议未净化」这类缺陷
  // （审计 #31：测试助手曾经硬编码 `(u) => u`，所以测不到 javascript: 链接）。
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { components, urlTransform: previewUrlTransform }, markdown),
  );
}

// 审计 #31（2026-10-24 报告 P1）：B4 曾把 urlTransform 改成全局恒等，连带关掉了
// react-markdown 的协议净化。侧栏是扩展自己的页面，点一个 javascript: 链接就在扩展
// 上下文里执行脚本。修法：只对 data:/blob: 放行，其余回到 defaultUrlTransform。
describe('审计 #31：链接协议必须净化（urlTransform 不再全局恒等）', () => {
  it('javascript: 链接的 href 必须被剥离', () => {
    const out = render('[点我](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
  });

  it('data: 链接同样不让通过（只对图片放行）', () => {
    const out = render('[点我](data:text/html,<script>alert(1)</script>)');
    expect(out).not.toContain('data:text/html');
  });

  it('普通 http/https 链接仍然可用（负控：别改过头）', () => {
    const out = render('[点我](https://example.test/doc)');
    expect(out).toContain('href="https://example.test/doc"');
  });

  it('内联图片仍然放行（负控：B4 的能力不能丢）', () => {
    const out = render('![x](data:image/png;base64,AAA)');
    expect(out).toContain('src="data:image/png;base64,AAA"');
  });

  it('外链图片仍被拦（负控：B6 的能力不能丢）', () => {
    const out = render('![x](https://evil.example/p.gif)');
    expect(out).not.toContain('src="https://evil.example/p.gif"');
    expect(out).toContain('外部图片已拦截');
  });
});

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
