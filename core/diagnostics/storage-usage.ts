// W24: 存储用量自检

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
