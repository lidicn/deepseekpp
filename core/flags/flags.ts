// W17: 统一 Feature Flag 中心
// 纯函数 + IO 注入，无外部依赖

export interface FlagDefinition {
  key: string;
  defaultValue: boolean;
  description: string;
  /** 灰度百分比 0-100；未设或 100 表示全量 */
  rolloutPercent?: number;
}

export const FLAG_REGISTRY = {
  resume_enabled: { key: 'resume_enabled', defaultValue: false, description: 'M1 真续跑', rolloutPercent: 0 },
  trace_enabled:  { key: 'trace_enabled',  defaultValue: false, description: '执行轨迹' },
  boot_health:    { key: 'boot_health',    defaultValue: true,  description: '启动自检' },
  tool_rate_limit:{ key: 'tool_rate_limit',defaultValue: true,  description: '工具速率限制' },
} as const satisfies Record<string, FlagDefinition>;

/** 稳定哈希，保证同一 installId 永远落同一侧 */
export function stableHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function shouldEnable(
  flag: FlagDefinition,
  installId: string,
  overrides: Record<string, boolean> = {},
): boolean {
  if (overrides[flag.key] !== undefined) return overrides[flag.key];
  const percent = flag.rolloutPercent ?? 100;
  if (percent >= 100) return flag.defaultValue;
  if (percent <= 0) return false;
  return stableHash(installId) % 100 < percent;
}
