import { isRecord, toText } from '../escape';
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
      // lazy/async 省流量与主线程；no-referrer 是刻意选择：不少图床按 Referer 判防盗链，
      // 不带 Referer 反而更容易过（豆瓣 418 就是"带了外来 Referer"导致的）。
      return (
        `<img class="${cls}" src="${ctx.escape(resolved.src)}" alt="${ctx.escape(alt)}"` +
        ` loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      );
    }
    // 语义区分：模型**没给图**（src=null）是 PoC 的设计内状态 → 渐变占位，**不算降级**；
    // 只有**协议被拒**（javascript:/data:/ftp: 等）才是安全降级，需要进 outcome。
    if (resolved.reason === 'image_unsafe_src') noteOutcome(ctx.outcome, 'degraded', resolved.reason);
    const fallback = isRecord(props.fallback) ? props.fallback : null;
    const hue = normalizeHue(fallback === null ? undefined : fallback.hue);
    return (
      `<div class="${cls} dppvis-img--placeholder" style="--dppvis-hue:${hue}"` +
      ` role="img" aria-label="${ctx.escape(alt)}"><span class="dppvis-img__alt">${ctx.escape(alt)}</span></div>`
    );
  },
};
