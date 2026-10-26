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

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/**
 * 按字节预算裁剪结构化 JSON 值，**保留对象形状**（不整体 stringify）。
 *
 * 起因（审计 #51/#15/#38/#89 同根）：上游曾用 `clampText(JSON.stringify(output), budget)`
 * 把 JsonValue 压成字符串，下游按 `typeof output === 'object'` 取 `output.stdout` 永远落空，
 * 代码执行的 stdout/stderr 被静默丢弃。
 *
 * 策略：
 *  - 未超预算：原样返回（深拷贝一份，避免改到调用方的对象）
 *  - 超预算：递归深拷贝，并把每个字符串叶子按「预算 ÷ 字符串叶子数」截断；
 *    非字符串叶子原样保留。这样对象的键结构、数组形状、数值都不变。
 *
 * 返回 `{ value, truncated }`；调用方把 `truncated` 写进 record.truncated。
 */
export function clampJsonValueToBytes<T extends JsonLike>(
  value: T | undefined,
  maxBytes: number,
): { value: T | undefined; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false };
  if (utf8ByteLength(JSON.stringify(value)) <= maxBytes) return { value, truncated: false };

  const stringLeaves: string[] = [];
  const collectLeaves = (node: JsonLike): void => {
    if (typeof node === 'string') {
      stringLeaves.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectLeaves(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) collectLeaves((node as Record<string, JsonLike>)[k]);
    }
  };
  collectLeaves(value);

  // 给 JSON 结构开销（键名、括号、引号、逗号）留 25% 余量：只按叶子均分会把
  // 序列化后的总字节推过预算（结构字节不可省）。
  const contentBudget = Math.floor(maxBytes * 0.75);
  const perLeafBudget = stringLeaves.length > 0
    ? Math.max(0, Math.floor(contentBudget / stringLeaves.length))
    : maxBytes;

  const clone = (node: JsonLike): JsonLike => {
    if (typeof node === 'string') return clampTextToBytes(node, perLeafBudget) ?? '';
    if (Array.isArray(node)) return node.map(clone);
    if (node && typeof node === 'object') {
      const out: Record<string, JsonLike> = {};
      for (const k of Object.keys(node)) out[k] = clone((node as Record<string, JsonLike>)[k]);
      return out;
    }
    return node;
  };

  return { value: clone(value) as T, truncated: true };
}
