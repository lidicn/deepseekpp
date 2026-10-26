// W24: 存储用量自检
/**
 * @workitem W24
 * @status  deferred
 * @since   2026-10-19 (introduced by fd593c1)
 * @note    纯函数已交付并有用例；接线点：诊断面板/设置页调用 estimateUsage 展示 quota 占用比（推断）
 */

export interface StorageUsage {
  bytes: number;
  ratio: number;
  overThreshold: boolean;
}

export function estimateUsage(
  entries: Record<string, unknown>,
  keys: readonly string[],
  quotaBytes = 10 * 1024 * 1024,
): StorageUsage {
  let bytes = 0;
  for (const key of keys) {
    const value = entries[key];
    if (value === undefined) continue;
    bytes += new Blob([JSON.stringify(value)]).size;
  }
  const ratio = bytes / quotaBytes;
  return {
    bytes,
    ratio,
    overThreshold: ratio > 0.7,
  };
}
