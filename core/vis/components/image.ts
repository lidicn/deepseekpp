import { escapeHtml, isRecord, toText } from '../escape';
import { DEFAULT_HUE, noteOutcome } from '../types';
import type { VisComponentRenderer } from '../registry';

function ratioClass(ratio: unknown): string {
  if (ratio === '2/3') return 'dppvis-ratio-2x3';
  if (ratio === '16/9') return 'dppvis-ratio-16x9';
  return '';
}

/** hue 归一化为 [0,360] 整数；非有限数回落默认值，杜绝样式串注入。 */
function normalizeHue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HUE;
  return Math.min(360, Math.max(0, Math.round(value)));
}

export const imageRenderer: VisComponentRenderer = {
  type: 'Image',
  allowsChildren: false,
  render(props, ctx) {
    const alt = toText(props.alt);
    const ratio = ratioClass(props.ratio);
    const cls = ratio === '' ? 'dppvis-img' : `dppvis-img ${ratio}`;
    const resolved = ctx.imageResolver.resolve(props.src);
    if (resolved.src !== null) {
      return `<img class="${cls}" src="${escapeHtml(resolved.src)}" alt="${escapeHtml(alt)}">`;
    }
    if (resolved.reason) noteOutcome(ctx.outcome, 'degraded', resolved.reason);
    const fallback = isRecord(props.fallback) ? props.fallback : null;
    const hue = normalizeHue(fallback === null ? undefined : fallback.hue);
    return (
      `<div class="${cls} dppvis-img--placeholder" style="${escapeHtml(`--dppvis-hue:${hue}`)}"` +
      ` role="img" aria-label="${escapeHtml(alt)}"><span class="dppvis-img__alt">${escapeHtml(alt)}</span></div>`
    );
  },
};
