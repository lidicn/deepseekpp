// 2026-10-23 审计 X-66 回归：artifact 预览的 srcdoc 必须带上「只钉出网向量」的 CSP。
//
// 缺陷：模型 HTML 原样进 `srcdoc`，而这条帧嵌在 `chat.deepseek.com` 页面里，
// 继承的是**聊天网站**的策略 —— 扩展为 `sandbox_run` 钉的 M13 防信标措施
// （`wxt.config.ts` 的 `SANDBOX_CSP`）在这条路上不生效。
//
// 本测试锁定：
//   A. 注入存在且落在 `<head>` 内
//   B. **不进 quirks mode** —— meta 不能出现在 `<!doctype>` 之前
//   C. 各文档形态都覆盖：有 head / 只有 html / 有 doctype / 纯片段
//   D. 幂等：已有 CSP meta 不重复注入
//   E. 策略内容确实钉死了三类信标向量（远程 img / CSS url() / @font-face）+ fetch
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PREVIEW_CSP,
  ARTIFACT_PREVIEW_CSP_ENABLED,
  injectArtifactPreviewCsp,
} from '../core/ui/artifact-preview-csp';

const META_NEEDLE = 'http-equiv="Content-Security-Policy"';

describe('X-66: injectArtifactPreviewCsp 注入位置', () => {
  it('有 <head> 时插到 head 开标签之后、任何资源之前', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>';
    const out = injectArtifactPreviewCsp(html);

    expect(out).toContain(META_NEEDLE);
    // meta 在 head 内，且在 title / body 之前
    const headAt = out.indexOf('<head>');
    const metaAt = out.indexOf(META_NEEDLE);
    expect(metaAt).toBeGreaterThan(headAt);
    expect(metaAt).toBeLessThan(out.indexOf('<title>'));
    expect(metaAt).toBeLessThan(out.indexOf('<body>'));
    // 正文没被动
    expect(out).toContain('<h1>hi</h1>');
  });

  it('head 带属性时也能正确插入', () => {
    const html = '<html><head lang="zh"><meta charset="utf-8"></head><body>x</body></html>';
    const out = injectArtifactPreviewCsp(html);
    expect(out).toContain(META_NEEDLE);
    expect(out.indexOf(META_NEEDLE)).toBeLessThan(out.indexOf('charset="utf-8"'));
  });

  it('有 <html> 无 <head> 时补一个 head', () => {
    const html = '<html><body><p>x</p></body></html>';
    const out = injectArtifactPreviewCsp(html);
    expect(out).toContain(META_NEEDLE);
    expect(out.indexOf(META_NEEDLE)).toBeLessThan(out.indexOf('<body>'));
    expect(out).toContain('<p>x</p>');
  });

  it('只有 <!doctype> 时，meta 落在 doctype **之后**（不进 quirks mode）', () => {
    const html = '<!doctype html><h1>bare</h1>';
    const out = injectArtifactPreviewCsp(html);
    const doctypeAt = out.toLowerCase().indexOf('<!doctype');
    const metaAt = out.indexOf(META_NEEDLE);
    expect(doctypeAt).toBe(0);
    expect(metaAt).toBeGreaterThan(doctypeAt);
    expect(out).toContain('<h1>bare</h1>');
  });

  it('纯片段被包成完整文档，meta 在最前且正文完整', () => {
    const html = '<div class="card">hello</div>';
    const out = injectArtifactPreviewCsp(html);
    expect(out.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain(META_NEEDLE);
    expect(out).toContain('<div class="card">hello</div>');
    // 片段内容仍在 body 里
    expect(out.indexOf(META_NEEDLE)).toBeLessThan(out.indexOf('<div class="card">'));
  });

  it('**任何形态下 meta 都不出现在 doctype 之前**（quirks mode 防线）', () => {
    const samples = [
      '<!doctype html><html><head></head><body>x</body></html>',
      '<!doctype html><html><body>x</body></html>',
      '<!doctype html><p>x</p>',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><head></head><body>x</body></html>',
      '<div>fragment</div>',
    ];
    for (const sample of samples) {
      const out = injectArtifactPreviewCsp(sample);
      const doctypeAt = out.toLowerCase().indexOf('<!doctype');
      const metaAt = out.indexOf(META_NEEDLE);
      expect(metaAt).toBeGreaterThan(-1);
      if (doctypeAt >= 0) expect(metaAt).toBeGreaterThan(doctypeAt);
    }
  });
});

describe('X-66: 幂等与开关', () => {
  it('已有 CSP meta 时不重复注入', () => {
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body>x</body></html>';
    const out = injectArtifactPreviewCsp(html);
    expect(out).toBe(html);
  });

  it('http-equiv 大小写/引号变体也认得出来（不重复注入）', () => {
    const html = '<html><head><META HTTP-EQUIV=Content-Security-Policy CONTENT="default-src \'none\'"></head></html>';
    expect(injectArtifactPreviewCsp(html)).toBe(html);
  });

  it('开关当前是开着的（回归：别被人误关）', () => {
    // 关掉就等于回到 X-66 的现状。若确需回退，改这个常量并同步改本断言。
    expect(ARTIFACT_PREVIEW_CSP_ENABLED).toBe(true);
  });

  it('空串与非法输入原样返回，不抛', () => {
    expect(injectArtifactPreviewCsp('')).toBe('');
    expect(injectArtifactPreviewCsp(undefined as unknown as string)).toBeUndefined();
  });
});

describe('X-66: 策略确实钉死了信标向量', () => {
  it('三类信标向量都只留内联资源', () => {
    // M13 注释点名的三条：远程图片、CSS url()、@font-face
    expect(ARTIFACT_PREVIEW_CSP).toContain('img-src data: blob:');
    expect(ARTIFACT_PREVIEW_CSP).toContain('font-src data: blob:');
    expect(ARTIFACT_PREVIEW_CSP).toContain('media-src data: blob:');
  });

  it('fetch / XHR / WebSocket 被禁，且没有放行任何远程源', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("default-src 'none'");
    // 不得出现 http/https 源
    expect(ARTIFACT_PREVIEW_CSP).not.toMatch(/https?:/);
    // 核心三指令里不得出现 *
    expect(ARTIFACT_PREVIEW_CSP).not.toContain("'*'");
  });

  it('保留内联脚本与样式（否则预览的交互全废）', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("style-src 'unsafe-inline'");
  });
});
