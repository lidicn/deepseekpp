// core/vis/render-poc.ts
// A2UI 子集 -> 安全 HTML 字符串（纯函数 PoC：无 DOM、无网络、零依赖）。
// 安全不变量：属性值要么是固定字面量，要么是 escapeHtml 的输出；类名只来自白名单映射。

export type TextVariant = "title" | "subtitle" | "body" | "meta";
export type ImageRatio = "2/3" | "16/9";

export type A2UITextNode = { type: "Text"; text: string; variant?: TextVariant };
export type A2UIImageNode = {
  type: "Image";
  src: string | null;
  alt: string;
  ratio?: ImageRatio;
  fallback?: { hue?: number };
};
export type A2UIColumnNode = { type: "Column"; children: A2UINode[] };
export type A2UINode = A2UITextNode | A2UIImageNode | A2UIColumnNode;
export type A2UIDocument = { v: 1; root: A2UINode };

export const MAX_DEPTH = 8;
export const MAX_TEXT_LENGTH = 400;
export const DEFAULT_HUE = 210;

function escapeChar(ch: string): string {
  switch (ch) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&#39;";
    default: return ch;
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

/** 转义 & < > " ' ；object/symbol/function 一律空串，不抛异常。 */
export function escapeHtml(value: unknown): string {
  return toText(value).replace(/[&<>"']/g, escapeChar);
}

/** 只认 http/https 开头（大小写不敏感、不 trim：前导空白即判不安全）。 */
export function isSafeImageSrc(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateText(raw: string): string {
  if (raw.length <= MAX_TEXT_LENGTH) return raw;
  let cut = MAX_TEXT_LENGTH;
  const last = raw.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // 不切开代理对
  return `${raw.slice(0, cut)}…`;
}

function variantClass(variant: unknown): string {
  switch (variant) {
    case "title": return "dppvis-text--title";
    case "subtitle": return "dppvis-text--subtitle";
    case "meta": return "dppvis-text--meta";
    default: return "dppvis-text--body";
  }
}

function ratioClass(ratio: unknown): string {
  if (ratio === "2/3") return "dppvis-ratio-2x3";
  if (ratio === "16/9") return "dppvis-ratio-16x9";
  return "";
}

/** hue 归一化为 [0,360] 整数；非有限数一律回落默认值，杜绝样式串注入。 */
function normalizeHue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HUE;
  return Math.min(360, Math.max(0, Math.round(value)));
}

/** 未知节点降级用的可读标题：依次取 title/text/alt/label/name。 */
function readableTitle(node: unknown): string {
  if (typeof node === "string" && node.trim() !== "") return node;
  if (!isRecord(node)) return "[unsupported node]";
  for (const key of ["title", "text", "alt", "label", "name"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const type = node.type;
  if (typeof type === "string" && type.trim() !== "") return `[unsupported: ${type.trim()}]`;
  return "[unsupported node]";
}

function renderText(textValue: unknown, variant: unknown): string {
  return `<div class="dppvis-text ${variantClass(variant)}">${escapeHtml(truncateText(toText(textValue)))}</div>`;
}

function renderImage(node: Record<string, unknown>): string {
  const alt = toText(node.alt);
  const ratio = ratioClass(node.ratio);
  const cls = ratio === "" ? "dppvis-img" : `dppvis-img ${ratio}`;
  if (isSafeImageSrc(node.src)) {
    return `<img class="${cls}" src="${escapeHtml(node.src)}" alt="${escapeHtml(alt)}">`;
  }
  const fallback = isRecord(node.fallback) ? node.fallback : null;
  const hue = normalizeHue(fallback === null ? undefined : fallback.hue);
  return (
    `<div class="${cls} dppvis-img--placeholder" style="${escapeHtml(`--dppvis-hue:${hue}`)}"` +
    ` role="img" aria-label="${escapeHtml(alt)}"><span class="dppvis-img__alt">${escapeHtml(alt)}</span></div>`
  );
}

function renderNode(node: unknown, depth: number): string {
  if (depth > MAX_DEPTH || node === null || node === undefined) return "";
  const record = isRecord(node) ? node : null;
  const type = record !== null && typeof record.type === "string" ? record.type : "";
  if (record !== null && type === "Column") {
    const children = Array.isArray(record.children) ? record.children : [];
    return `<div class="dppvis-column">${children.map((child) => renderNode(child, depth + 1)).join("")}</div>`;
  }
  if (record !== null && type === "Image") return renderImage(record);
  if (record !== null && type === "Text") return renderText(record.text, record.variant);
  return renderText(readableTitle(node), "meta");
}

/** 入口：接受 A2UI 文档（{v:1, root}），返回安全 HTML；任何输入都不抛异常。 */
export function renderPocHtml(input: unknown): string {
  const root = isRecord(input) ? input.root : undefined;
  return `<div class="dppvis-root">${renderNode(root, 1)}</div>`;
}
