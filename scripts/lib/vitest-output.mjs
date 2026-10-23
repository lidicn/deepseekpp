/**
 * vitest verbose 输出的解析工具（纯函数，无副作用，可单测）。
 *
 * 抽出来的原因见审计 X-52：`test-with-baseline.mjs` 的门禁尺曾经直接
 * 在**带 ANSI 转义码**的原始输出上做行首正则匹配，于是永远命中 0 条
 * failed，把「没看见红」误报成「没有红」。为让它可被自检腿直接测，
 * 解析逻辑必须与「跑 vitest」的副作用分开。
 */

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** 剥掉 ANSI 颜色/样式转义码与 CR，保留可读文本。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

/**
 * 从 vitest verbose 输出里解析失败用例名。
 *
 * verbose 的失败行形如（剥 ANSI 后）：
 *   `   × tests/a.test.ts > suite > case 123ms`
 * 返回集合里每项是 `tests/a.test.ts > suite > case`（含文件名）。
 */
export function parseFailedCases(output) {
  const failed = new Set();
  for (const line of stripAnsi(output).split('\n')) {
    const match = line.match(/^\s*×\s+(.+?)\s+\d+ms/);
    if (match) failed.add(match[1].trim());
  }
  return failed;
}

/**
 * 判断一个已解析出的失败用例是否被基线覆盖。
 *
 * 基线条目可以是文件级（`tests/a.test.ts`）或用例级；分隔符接受 `::` 与 ` > `。
 * `::TODO` / `::` 结尾的占位条目会匹配一切，必须跳过。
 */
export function isCoveredByBaseline(failedCase, baseline) {
  for (const entry of baseline) {
    if (entry.endsWith('::TODO') || entry.endsWith('::')) continue;
    if (entry === failedCase) return true;
    if (failedCase.startsWith(`${entry}::`)) return true;
    if (failedCase.startsWith(`${entry} > `)) return true;
  }
  return false;
}
