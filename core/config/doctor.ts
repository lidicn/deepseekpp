// T33: 配置健康检查纯函数

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
