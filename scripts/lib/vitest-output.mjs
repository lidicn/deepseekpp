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

/**
 * 反向校验（P0-3）：找出基线里指向「已不存在的测试文件」的条目。
 *
 * 门禁原本只做「实际失败 ⊄ 基线 ⇒ 报错」，不做反向。于是有人把已修好的
 * 条目写回去、或手滑写了个不存在的路径，不会有任何提示 —— 那条死条目会
 * 永远静默放行将来真正的回归。
 *
 * 规则：从每条基线里抽出它指向的测试文件（分隔符 ` > ` 或 `::` 之前的部分），
 * 与 `existingTestFiles`（git ls-files tests 的产物）比对；抽出来不是一个
 * tests/… 路径、或占位条目（::TODO / 空）的，跳过不算 stale。
 *
 * 返回「stale 条目」数组（保持原字符串）；空数组 = 全部命中真实文件。
 */
export function findStaleBaselineEntries(baselineEntries, existingTestFiles) {
  const existing = new Set(existingTestFiles);
  const stale = [];
  for (const entry of baselineEntries) {
    if (!entry || entry.endsWith('::TODO') || entry.endsWith('::')) continue;
    const filePart = entry.split(/\s*>\s*|::/)[0].trim();
    // 只对形如 tests/... 的路径做存在性校验；其它（纯用例名、占位）放过。
    if (!filePart.startsWith('tests/')) continue;
    if (!existing.has(filePart)) stale.push(entry);
  }
  return stale;
}
