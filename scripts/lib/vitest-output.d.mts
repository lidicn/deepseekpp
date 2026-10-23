/**
 * `vitest-output.mjs` 的类型声明。
 *
 * 实现是纯 ESM 的 `.mjs`（被 `scripts/test-with-baseline.mjs` 这个 Node 脚本直跑，
 * 不走 TS 编译）；测试腿需要从 `.ts` 导入它，所以这里补声明。
 */

/** 剥掉 ANSI 颜色/样式转义码与 CR。 */
export function stripAnsi(text: unknown): string;

/** 从 vitest verbose 输出里解析失败用例名（含文件名与 ` > ` 分隔的套件路径）。 */
export function parseFailedCases(output: string): Set<string>;

/** 判断失败用例是否被基线条目覆盖。 */
export function isCoveredByBaseline(failedCase: string, baseline: Iterable<string>): boolean;
