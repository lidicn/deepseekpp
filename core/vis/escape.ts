/**
 * 文本出口与安全判定。整个 vis 模块**只有这里**允许产生 HTML 片段。
 * 不变量：属性值与文本节点都必须经过 escapeHtml。
 */
import { MAX_TEXT_LENGTH } from './types';

function escapeChar(ch: string): string {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return ch;
  }
}

/** object / symbol / function 一律空串，绝不抛异常。 */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/** 转义 & < > " ' —— 唯一允许的 HTML 文本出口。 */
export function escapeHtml(value: unknown): string {
  return toText(value).replace(/[&<>"']/g, escapeChar);
}

/** 超长截断：不切开代理对（否则会出现半个 emoji）。 */
export function truncateText(raw: string): string {
  if (raw.length <= MAX_TEXT_LENGTH) return raw;
  let cut = MAX_TEXT_LENGTH;
  const last = raw.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${raw.slice(0, cut)}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
