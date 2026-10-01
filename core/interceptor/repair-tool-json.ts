/**
 * repair-tool-json.ts —— 工具调用 JSON 转义容错修复层
 *
 * 背景：模型输出的工具调用 JSON 里经常出现未正确转义的特殊字符
 * （Windows 路径反斜杠 `D:\project\file.txt`、字符串内裸换行等），
 * 导致 JSON.parse 抛错 → tool_call_json_invalid。
 *
 * 本模块在 JSON.parse 失败后做一次保守修复。
 *
 * 对外契约（repairToolJsonBody）：
 *   1. 已合法的 JSON 原样返回（同一引用，不做任何改写）；
 *   2. 返回非 null 时，返回值必定能被 JSON.parse 成功解析；
 *   3. 无法可靠修复时返回 null，由调用方维持原有错误处理；
 *   4. 只改写字符串字面量内部，不触碰 JSON 结构（括号 / 逗号 / 冒号 / 键名）。
 *
 * 零新依赖：纯字符串扫描，O(n)。
 */

/** JSON 合法的单字符转义字符（\uXXXX 另行处理） */
const SIMPLE_ESCAPE_CHARS = '"\\/bfnrt';

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

/**
 * 尝试修复 body 中的 JSON 转义问题。
 *
 * @returns 可被 JSON.parse 成功解析的字符串；无法可靠修复时返回 null。
 */
import { refactorTelemetry } from '../debug/refactor-telemetry';

export function repairToolJsonBody(body: string): string | null {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }

  // 合法 JSON 不做任何修改（验收标准 1）
  if (isParsable(body)) {
    return body;
  }

  // 策略 1 + 2：修复字符串字面量内部的转义问题
  const escapesFixed = repairStringContents(body);
  if (escapesFixed !== body && isParsable(escapesFixed)) {
    refactorTelemetry.recordEscapeRepair(true);
    return escapesFixed;
  }

  // 策略 3：保守修复字符串内的裸引号（仅在能确定上下文时）
  const quotesFixed = repairUnescapedQuotes(escapesFixed);
  if (quotesFixed !== escapesFixed && isParsable(quotesFixed)) {
    refactorTelemetry.recordEscapeRepair(true);
    return quotesFixed;
  }

  refactorTelemetry.recordEscapeRepair(false);
  return null;
}

// ---------------------------------------------------------------------------
// 策略 1 + 2：字符串字面量内部的转义修复
// ---------------------------------------------------------------------------

/** 逐个字符串字面量处理；字面量之外（JSON 结构）原样拷贝 */
function repairStringContents(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input.charAt(i);

    if (ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }

    const closeIndex = findStringLiteralEnd(input, i);
    if (closeIndex === -1) {
      // 字符串字面量未闭合：结构性损坏，不再尝试修复
      out += input.slice(i);
      break;
    }

    out += '"' + repairStringBody(input.slice(i + 1, closeIndex)) + '"';
    i = closeIndex + 1;
  }

  return out;
}

/** 转义感知地查找字符串字面量的结束引号；找不到返回 -1 */
function findStringLiteralEnd(input: string, openIndex: number): number {
  let i = openIndex + 1;

  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i;
    }
    i += 1;
  }

  return -1;
}

/** 修复单个字符串字面量的内容（不含两侧引号） */
function repairStringBody(body: string): string {
  const invalidEscape = hasInvalidEscape(body);
  const controlChar = hasControlChar(body);
  const windowsPath = looksLikeWindowsPath(body);

  // 三个信号都不命中：合法转义一律保留，原样返回
  if (!invalidEscape && !controlChar && !windowsPath) {
    return body;
  }

  // 出现非法转义或路径特征 ⇒ 书写者大概率根本没做 JSON 转义，
  // 此时只有 \\ \" \/ \uXXXX 视为"有意转义"，其余反斜杠按字面反斜杠处理。
  const literalBackslashes = invalidEscape || windowsPath;

  let out = '';
  let i = 0;

  while (i < body.length) {
    const ch = body.charAt(i);

    if (ch === '\\') {
      const next = body.charAt(i + 1);

      if (next === '') {
        // 末尾孤立反斜杠
        out += '\\\\';
        i += 1;
        continue;
      }
      if (next === 'u' && isUnicodeEscapeAt(body, i)) {
        // 合法 \uXXXX 原样保留
        out += body.slice(i, i + 6);
        i += 6;
        continue;
      }
      if (next === '"' || next === '\\' || next === '/') {
        // 合法转义原样保留
        out += ch + next;
        i += 2;
        continue;
      }
      if (!literalBackslashes && isSimpleEscapeChar(next)) {
        // 非路径语境下的合法转义（\n \t \r \b \f）原样保留
        out += ch + next;
        i += 2;
        continue;
      }

      // 策略 1：字面反斜杠 → \\
      out += '\\\\';
      i += 1;
      continue;
    }

    if (isControlChar(ch)) {
      // 策略 2：裸换行 / 裸 Tab / 其它控制字符
      out += escapeControlChar(ch);
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** 是否存在"不是合法 JSON 转义"的反斜杠 */
function hasInvalidEscape(body: string): boolean {
  let i = 0;

  while (i < body.length) {
    if (body.charAt(i) !== '\\') {
      i += 1;
      continue;
    }

    const next = body.charAt(i + 1);
    if (next === 'u' && isUnicodeEscapeAt(body, i)) {
      i += 6;
      continue;
    }
    if (isSimpleEscapeChar(next)) {
      i += 2;
      continue;
    }
    return true;
  }

  return false;
}

function hasControlChar(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    if (isControlChar(body.charAt(i))) {
      return true;
    }
  }
  return false;
}

/**
 * 判断字符串内容是否像 Windows / UNC / 相对路径。
 * 命中时按"书写者未做 JSON 转义"处理。
 */
function looksLikeWindowsPath(body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  // 盘符路径：D:\project\file.txt、D:/project/file.txt
  if (/^[A-Za-z]:/.test(body)) {
    return true;
  }

  // UNC 或以反斜杠开头
  if (body.charAt(0) === '\\') {
    return true;
  }

  // .\ 与 ..\ 相对路径
  if (/^\.\.?\\/.test(body)) {
    return true;
  }

  // 多段相对路径：src\node\file.ts
  if (body.indexOf('://') !== -1 || /\s/.test(body)) {
    return false;
  }
  const first = body.indexOf('\\');
  return first !== -1 && first !== body.lastIndexOf('\\');
}

// ---------------------------------------------------------------------------
// 策略 3：字符串内的裸引号（保守）
// ---------------------------------------------------------------------------

/**
 * 只有当引号后面紧跟 JSON 结构字符（: , } ]）或到达输入末尾时，
 * 才认为它是字符串结束引号；否则保守地按"字符串内容里的裸引号"转义。
 */
function repairUnescapedQuotes(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input.charAt(i);

    if (ch === '\\') {
      out += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }

    if (!inString) {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (isStringTerminatorAhead(input, i + 1)) {
      inString = false;
      out += ch;
    } else {
      out += '\\"';
    }
    i += 1;
  }

  return out;
}

function isStringTerminatorAhead(input: string, from: number): boolean {
  let i = from;

  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    return ':,}]'.indexOf(ch) !== -1;
  }

  // 引号位于输入末尾，只能是结束引号
  return true;
}

// ---------------------------------------------------------------------------
// 字符级工具
// ---------------------------------------------------------------------------

function isParsable(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isSimpleEscapeChar(ch: string): boolean {
  return ch !== '' && SIMPLE_ESCAPE_CHARS.indexOf(ch) !== -1;
}

function isUnicodeEscapeAt(body: string, index: number): boolean {
  return (
    body.charAt(index) === '\\' &&
    body.charAt(index + 1) === 'u' &&
    isHexDigit(body.charAt(index + 2)) &&
    isHexDigit(body.charAt(index + 3)) &&
    isHexDigit(body.charAt(index + 4)) &&
    isHexDigit(body.charAt(index + 5))
  );
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F')
  );
}

function isControlChar(ch: string): boolean {
  return ch !== '' && ch.charCodeAt(0) < 0x20;
}

function escapeControlChar(ch: string): string {
  switch (ch) {
    case '\b':
      return '\\b';
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\f':
      return '\\f';
    case '\r':
      return '\\r';
    default: {
      const hex = ch.charCodeAt(0).toString(16);
      return '\\u' + ('0000' + hex).slice(-4);
    }
  }
}
