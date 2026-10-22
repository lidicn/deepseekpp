/**
 * 按**字节**截断文本，并在 UTF-8 字符边界对齐。
 *
 * 2026-10-22 说明（起因：兄弟项目 Studio 的对齐建议书 §3.2）：
 *
 * Studio 指出 dpp 的截断「切点可能落在一个多字节字符中间」。核实后：
 * dpp 其实已有两套同名实现，语义不同 ——
 *
 *   · `core/tool-loop/engine.ts` 的 clampText —— **字节口径 + UTF-8 边界回退**（正确）
 *   · `core/tool/execution-restore.ts` 的 clampText —— **字符口径**（`value.length` / `slice`）
 *
 * 而 `AUTOMATION_TOOL_DETAIL_MAX_BYTES = 4000`（注释写「4 KB」）恰好流进了
 * 字符口径那一套：CJK 下 4000 字符 ≈ 12000 字节，预算实际松了 3 倍，
 * 与注释声明的「防止把 MB 级数据推进 chrome.storage.local」不符。
 *
 * 本模块把正确实现收敛到一处，两个调用方共用，避免再次漂移。
 *
 * 边界回退原理：UTF-8 的续字节形如 `10xxxxxx`（高两位为 10）。若切点正好落在
 * 续字节上，说明它属于前一个字符，必须向前退到字符起始字节，否则
 * `TextDecoder` 会把它解码成替换符（U+FFFD），数据被静默损坏。
 */

/** 截断标记；计入预算，保证「截断后总字节数 ≤ maxBytes」。 */
export const TRUNCATION_MARKER = '\n...[truncated]';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 把文本截到不超过 `maxBytes` 个 UTF-8 字节，能装下时追加截断标记。
 *
 * - 未超预算：原样返回（不重新编码）
 * - 超预算且预算装得下标记：保留尽可能多的**完整字符** + 标记，整体不超预算
 * - 超预算但预算装不下标记：直接硬截到 maxBytes，**不丢内容、不加标记**。
 *   这与 `core/tool/result-governance.ts` 的既有约定一致（那里也是
 *   「limit 太小时丢弃标记但保证不超预算」，由调用方自己置 `truncated`）。
 *   返回空串是错的 —— 那会把数据全丢掉。
 */
export function clampTextToBytes(
  value: string | undefined,
  maxBytes: number,
): string | undefined {
  if (!value) return value;
  if (maxBytes <= 0) return '';

  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;

  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength;
  const canCarryMarker = maxBytes >= markerBytes;
  const contentLimit = canCarryMarker ? maxBytes - markerBytes : maxBytes;

  let boundary = Math.min(contentLimit, bytes.byteLength);
  // 回退到 UTF-8 字符起始字节：续字节形如 10xxxxxx。
  while (boundary > 0 && ((bytes[boundary] ?? 0) & 0xc0) === 0x80) boundary--;

  const body = decoder.decode(bytes.subarray(0, boundary));
  return canCarryMarker ? `${body}${TRUNCATION_MARKER}` : body;
}

/** 返回文本的 UTF-8 字节长度（截断预算的度量口径）。 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
