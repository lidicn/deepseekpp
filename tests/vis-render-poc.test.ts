// tests/vis-render-poc.test.ts
// 单测对象：core/vis/render-poc.ts。纯断言、零新增依赖。
// 运行：npx vitest run tests/vis-render-poc.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUE,
  MAX_TEXT_LENGTH,
  escapeHtml,
  isSafeImageSrc,
  renderPocHtml,
} from "../core/vis/render-poc";

const doc = (root: unknown): unknown => ({ v: 1, root });
const text = (value: string, variant?: unknown): unknown => ({ type: "Text", text: value, variant });
const img = (over: Record<string, unknown>): unknown => ({ type: "Image", src: null, alt: "", ...over });
const nest = (levels: number, leaf: unknown): unknown => {
  let node: unknown = leaf;
  for (let i = 1; i < levels; i += 1) node = { type: "Column", children: [node] };
  return node;
};

describe("escapeHtml / isSafeImageSrc", () => {
  it("转义五类字符，非字符串值不抛", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(12)).toBe("12");
    expect(escapeHtml(Symbol("s"))).toBe("");
    expect(isSafeImageSrc("https://a.test/x.png")).toBe(true);
    expect(isSafeImageSrc("HTTPS://A.TEST")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AA", "ftp://a.test", null, undefined, "", " https://a.test"]) {
      expect(isSafeImageSrc(bad)).toBe(false);
    }
  });
});

describe("Text", () => {
  it("转义 + variant 白名单映射，非法 variant 回落 body", () => {
    const html = renderPocHtml(doc(text(`<b>&"'</b>`)));
    expect(html).toContain("&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(renderPocHtml(doc(text("t", "title")))).toContain("dppvis-text--title");
    expect(renderPocHtml(doc(text("t", "subtitle")))).toContain("dppvis-text--subtitle");
    expect(renderPocHtml(doc(text("t", "meta")))).toContain("dppvis-text--meta");
    expect(renderPocHtml(doc(text("t", "HUGE")))).toContain("dppvis-text--body");
  });
  it("400 字边界与代理对保护", () => {
    const over = renderPocHtml(doc(text("x".repeat(401))));
    expect(over).toContain("x".repeat(MAX_TEXT_LENGTH) + "…");
    expect(over).not.toContain("x".repeat(401));
    expect(renderPocHtml(doc(text("y".repeat(MAX_TEXT_LENGTH))))).not.toContain("…");
    const emoji = renderPocHtml(doc(text("a".repeat(399) + "😀")));
    expect(emoji).toContain("a".repeat(399) + "…");
    expect(emoji).not.toContain("\uDE00");
  });
});

describe("Image", () => {
  it("安全 src 出 <img>，属性值全部转义", () => {
    const html = renderPocHtml(doc(img({ src: "https://a.test/i.png", alt: `a" onerror="x`, ratio: "2/3" })));
    expect(html).toContain('<img class="dppvis-img dppvis-ratio-2x3"');
    expect(html).toContain('src="https://a.test/i.png"');
    expect(html).toContain('alt="a&quot; onerror=&quot;x"');
    expect(html).not.toContain('onerror="x"');
    expect(renderPocHtml(doc(img({ src: "https://a.test/i.png", ratio: "16/9" })))).toContain("dppvis-ratio-16x9");
    expect(renderPocHtml(doc(img({ src: "https://a.test/i.png", ratio: "4/3" })))).not.toContain("dppvis-ratio-");
  });
  it("非 http(s) 一律渐变占位，hue 归一化/钳制/回落", () => {
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AA", "ftp://a.test", null, undefined, " https://a.test"]) {
      const html = renderPocHtml(doc(img({ src: bad })));
      expect(html).toContain("dppvis-img--placeholder");
      expect(html).toContain(`style="--dppvis-hue:${DEFAULT_HUE}"`);
      expect(html).not.toContain("<img");
    }
    expect(renderPocHtml(doc(img({ fallback: { hue: 123 } })))).toContain('style="--dppvis-hue:123"');
    expect(renderPocHtml(doc(img({ fallback: { hue: -20 } })))).toContain('style="--dppvis-hue:0"');
    expect(renderPocHtml(doc(img({ fallback: { hue: 400 } })))).toContain('style="--dppvis-hue:360"');
    for (const bad of ["210;}", Number.NaN, Number.POSITIVE_INFINITY, "210"]) {
      expect(renderPocHtml(doc(img({ fallback: { hue: bad } })))).toContain(`style="--dppvis-hue:${DEFAULT_HUE}"`);
    }
  });
  it("占位保留可读 alt 且属性不可截断", () => {
    const html = renderPocHtml(doc(img({ alt: `"><img src=x onerror=alert(1)>` })));
    expect(html).toContain('aria-label="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('<span class="dppvis-img__alt">');
    expect(html).not.toContain("<img src=x");
  });
});

describe("降级 / 深度 / 纯函数", () => {
  it("未知 type 降级为 Text(meta)，保留标题，丢子树", () => {
    const html = renderPocHtml(doc({ type: "Chart", title: "标题 <x>" }));
    expect(html).toContain("dppvis-text--meta");
    expect(html).toContain("标题 &lt;x&gt;");
    expect(renderPocHtml(doc({ type: "Chart", children: [text("inner")] }))).not.toContain("inner");
    expect(renderPocHtml(doc({ type: "Chart" }))).toContain("[unsupported: Chart]");
    expect(renderPocHtml(doc({}))).toContain("[unsupported node]");
    expect(() => renderPocHtml(doc({ type: 123, title: Symbol("s") }))).not.toThrow();
  });
  it("顶层与 children 容错，深度上限 8，循环不炸", () => {
    expect(renderPocHtml(undefined)).toBe('<div class="dppvis-root"></div>');
    expect(renderPocHtml({ v: 1 })).toBe('<div class="dppvis-root"></div>');
    expect(renderPocHtml(doc({ type: "Column", children: "nope" }))).toContain('<div class="dppvis-column"></div>');
    expect(renderPocHtml(doc({ type: "Column", children: [null, text("ok")] })).split("dppvis-text--").length).toBe(2);
    expect(renderPocHtml(doc(nest(8, text("leaf"))))).toContain("leaf");
    const deep = renderPocHtml(doc(nest(9, text("deep"))));
    expect(deep).not.toContain("deep");
    expect(deep).toContain("dppvis-column");
    const cycle: Record<string, unknown> = { type: "Column", children: [] };
    cycle.children = [cycle];
    expect(() => renderPocHtml(doc(cycle))).not.toThrow();
    expect(renderPocHtml(doc(cycle)).length).toBeLessThan(400);
  });
  it("纯函数不变式 + XSS 样例", () => {
    const tree = doc({ type: "Column", children: [text("<script>alert(1)</script>"), img({ src: "https://a.test/i.png" })] });
    const before = JSON.stringify(tree);
    const html = renderPocHtml(tree);
    expect(renderPocHtml(tree)).toBe(html);
    expect(JSON.stringify(tree)).toBe(before);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});
