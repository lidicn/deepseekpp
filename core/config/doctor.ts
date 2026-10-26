// T33: 配置健康检查纯函数
/**
 * @workitem T33
 * @status  deferred
 * @since   2026-10-19 (introduced by fd593c1)
 * @note    纯函数已交付并有用例；接线点：设置页/诊断面板渲染 ConfigCheck 列表，标出 actual≠expected 的 key（推断）
 */

export interface ConfigCheck {
  key: string;
  ok: boolean;
  actual: string;
  expected: string;
}

const EXPECTED: Record<string, string> = {
  deepseek_pp_chat_enabled: 'boolean',
  deepseek_pp_resume_flags: 'object',
};

export function checkConfig(snapshot: Record<string, unknown>): ConfigCheck[] {
  return Object.entries(EXPECTED).map(([key, expected]) => ({
    key,
    ok: typeof snapshot[key] === expected,
    actual: typeof snapshot[key],
    expected,
  }));
}
