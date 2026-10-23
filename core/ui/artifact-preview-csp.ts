/**
 * artifact 预览的 CSP 注入（2026-10-23，审计 X-66 方案 3′）。
 *
 * ## 背景
 *
 * 扩展里有两条跑模型 HTML 的路，安全等级不一致：
 *
 *   · `sandbox_run` 工具 → 扩展自己的 `sandbox.pages` → 受 `wxt.config.ts` 的
 *     `SANDBOX_CSP` 约束。那段 CSP 的注释写明它在防什么：
 *     「img-src / style-src are pinned so sandboxed HTML cannot use remote images
 *      or CSS url() as network beacons (M13)」。
 *   · **artifact 预览** → 塞进 `chat.deepseek.com` 页面里的 `srcdoc` 帧 →
 *     继承的是**聊天网站**的策略，扩展的 M13 钉扎在这条路上不生效。
 *
 * ## 本模块做什么
 *
 * 在 `srcdoc` 赋值前，往模型 HTML 里注入一段**只钉出网向量**的 CSP：
 * 保留 inline script / inline style / data: / blob:，切断一切外联。
 *
 * 之所以不照搬 `SANDBOX_CSP`：那段是给扩展自己的沙箱页用的，可以放任
 * `'unsafe-eval'`、`blob:` worker 等；预览帧的诉求更窄 —— 只要求
 * 「不许向外部发请求」。
 *
 * ## 为什么内层 meta 是可信的
 *
 * CSP 是**多策略取交集**：外层（聊天网站或扩展页面）已有策略时，内层 meta
 * 只能**收紧**，不能放宽。所以即使模型在 HTML 里再写一个 CSP meta 想关掉它，
 * 也无法把已生效的限制放宽。这是本方案成立的关键前提。
 *
 * ## 一个必须小心的实现细节
 *
 * meta 必须落在 `<head>` 内、且在任何可加载资源之前。
 * **不能简单地把字符串拼在内容最前面** —— 那会出现在 `<!doctype html>` 之前，
 * 让文档进入 **quirks mode**，整个版面都会变。所以按下面的分支处理。
 */

/**
 * 总开关：出问题可一键回到「不注入」的原行为。
 *
 * 关掉之后预览恢复成「模型 HTML 原样进 srcdoc」——即审计 X-66 描述的现状，
 * 仅作为回退手段，不应长期关闭。
 */
export const ARTIFACT_PREVIEW_CSP_ENABLED = true;

/**
 * 只钉出网向量：
 *   · default-src 'none'   —— 兜底：没显式允许的一律不许
 *   · script-src 'unsafe-inline' —— 模型 HTML 自己的内联脚本要能跑
 *   · style-src 'unsafe-inline'  —— 内联样式要能用
 *   · img/media/font-src data: blob: —— 内联资源保留（这是 M13 注释里点名的
 *     三条信标向量：远程图片、CSS url()、@font-face，全部只留给内联）
 *   · connect-src 'none'   —— fetch / XHR / WebSocket 一律禁止
 */
export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data: blob:',
  "connect-src 'none'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">`;

/** 文档里是否已经有 CSP meta（避免重复注入）。 */
function hasCspMeta(html: string): boolean {
  return /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?/i.test(html);
}

/**
 * 把预览 CSP 注入模型 HTML。
 *
 * 分支（按优先级）：
 *   1. 开关关闭 / 已有 CSP meta → 原样返回
 *   2. 有 `<head ...>` → 插到该开标签之后（保证在任何资源之前、且在 head 内）
 *   3. 有 `<html ...>` 但无 head → 在该开标签之后插 `<head>…</head>`
 *   4. `<!doctype>` 之后直接是内容 → 在 doctype 之后插 `<html><head>…</head>`
 *   5. 纯片段 → 包一层完整文档
 */
export function injectArtifactPreviewCsp(html: string): string {
  if (!ARTIFACT_PREVIEW_CSP_ENABLED) return html;
  if (typeof html !== 'string' || html.length === 0) return html;
  if (hasCspMeta(html)) return html;

  // 2. 有 <head ...>
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
  }

  // 3. 有 <html ...> 但无 <head>
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
  }

  // 4. 有 <!doctype ...>（此时 head/html 都没有）
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}<html><head>${CSP_META}</head><body>${html.slice(at)}</body></html>`;
  }

  // 5. 纯片段：包一层完整文档（拼接处不留换行，避免 body 前置空白文本节点）
  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}
