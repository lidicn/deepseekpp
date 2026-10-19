// W28: 配置快照与还原

export interface ConfigSnapshot {
  version: number;
  exportedAt: number;
  entries: Record<string, unknown>;
}

export function buildSnapshot(
  entries: Record<string, unknown>,
  keys: readonly string[],
): ConfigSnapshot {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in entries) picked[key] = entries[key];
  }
  return { version: 1, exportedAt: Date.now(), entries: picked };
}

export function validateSnapshot(raw: unknown): { ok: true; snapshot: ConfigSnapshot } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_object' };
  const s = raw as Partial<ConfigSnapshot>;
  if (typeof s.version !== 'number') return { ok: false, reason: 'missing_version' };
  if (typeof s.exportedAt !== 'number') return { ok: false, reason: 'missing_exportedAt' };
  if (!s.entries || typeof s.entries !== 'object') return { ok: false, reason: 'missing_entries' };
  return { ok: true, snapshot: s as ConfigSnapshot };
}
