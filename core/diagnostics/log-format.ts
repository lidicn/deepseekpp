// W26: 诊断日志格式统一
/**
 * @workitem W26
 * @status  deferred
 * @since   2026-10-19 (introduced by fd593c1)
 * @note    纯函数已交付并有用例；接线点：core/diagnostics/ 输出结构化日志时统一走 fmtFields（推断）
 */

export function fmtFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
}
