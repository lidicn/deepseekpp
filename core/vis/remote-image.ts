/**
 * 远程图片通路（无运行时授权）。
 *
 * 设计前提：host 权限在 manifest 里一次性声明（http(s)://*\/*），
 * 所以这里不需要"申请权限"的状态机，只有「后台抓图 → 得到 data URL / 失败」。
 * content script 侧只持有一个 `RemoteImagePort`，实现放在 entrypoints 里（碰 chrome.*）。
 */

export interface RemoteImagePort {
  /** 由后台抓取并转 data URL；失败返回 null（调用方降级为渐变占位）。 */
  fetchAsDataUrl(url: string): Promise<string | null>;
}

/** 归一成 match pattern 用 origin（Chrome 的 pattern 不带端口，host 即匹配任意端口）。 */
export function originPatternOf(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

export function hostOf(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    return new URL(rawUrl).hostname || null;
  } catch {
    return null;
  }
}

/** 抓图，任何失败都返回 null（绝不抛）。 */
export async function fetchRemoteImage(rawUrl: unknown, port: RemoteImagePort): Promise<string | null> {
  if (!originPatternOf(rawUrl) || typeof rawUrl !== 'string') return null;
  try {
    return await port.fetchAsDataUrl(rawUrl);
  } catch {
    return null;
  }
}
