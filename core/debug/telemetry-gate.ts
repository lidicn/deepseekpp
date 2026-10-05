/**
 * 调试遥测开关（DCD 20261005 §二 裁定 A）
 *
 * 侧栏设置项 `dpp_debug_telemetry_enabled` 是权威来源，缺失时按"开启"处理；
 * 值由 Content（隔离世界）镜像写入页面 localStorage 的 `dpp_debug`，
 * 页面控制台手动设置 `dpp_debug='0'` 继续作为兜底。
 */

export const DEBUG_GATE_STORAGE_KEY = 'dpp_debug';
export const TELEMETRY_SETTING_STORAGE_KEY = 'dpp_debug_telemetry_enabled';

interface LocalStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
}

export async function readTelemetrySetting(storage: LocalStorageLike): Promise<boolean> {
  const result = await storage.get(TELEMETRY_SETTING_STORAGE_KEY);
  return result[TELEMETRY_SETTING_STORAGE_KEY] !== false;
}

export function applyTelemetryGate(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEBUG_GATE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // 隐私模式或配额限制：保持页面现有门控不变
  }
}

export function isTelemetryCaptureEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DEBUG_GATE_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
