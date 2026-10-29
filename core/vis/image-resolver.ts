/**
 * 图片解析注入点。
 *
 * 为什么不在渲染器里写死：防盗链图源（豆瓣等）需要「background 代理 → data: URL」，
 * 那是 PoC-2 的事。渲染器只依赖这个接口，换策略不动渲染代码。
 */
export interface ResolvedImage {
  /** 可安全放进 <img src> 的地址；null 表示走渐变占位。 */
  src: string | null;
  /** 解析失败原因（进 RenderOutcome，便于观测）。 */
  reason?: string;
}

export interface ImageResolver {
  resolve(rawSrc: unknown): ResolvedImage;
}

/** 只认 http/https（大小写不敏感、不 trim：前导空白即判不安全）。 */
export function isSafeImageSrc(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** PoC 默认策略：安全协议直接透传，其余占位。 */
export const passthroughImageResolver: ImageResolver = {
  resolve(rawSrc) {
    if (isSafeImageSrc(rawSrc)) return { src: rawSrc };
    return { src: null, reason: rawSrc == null ? 'image_missing' : 'image_unsafe_src' };
  },
};
