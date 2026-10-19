import { describe, expect, it } from 'vitest';
import { parseSha256Checksum, SHA256_ALGORITHM } from '../core/sync/checksum';
import {
  getSyncGenerationFileKey,
  getSyncGenerationManifestKey,
  isSyncFileKey,
  OPTIONAL_SYNC_FILE_KEYS,
  REQUIRED_SYNC_FILE_KEYS,
  SYNC_FILE_KEYS,
} from '../core/sync/contracts';

// T25: 只测无网络/无存储 IO 的纯函数——checksum 解析与 generation key 契约。
// 网络 client、store、coordinator 由既有 sync-*.test.ts 覆盖。

const HEX_64 = 'a'.repeat(64);

describe('parseSha256Checksum', () => {
  it('accepts a valid sha256 hex object and returns normalized fields', () => {
    const parsed = parseSha256Checksum({ algorithm: 'sha256', value: HEX_64 }, 'expected');
    expect(parsed.algorithm).toBe(SHA256_ALGORITHM);
    expect(parsed.value).toBe(HEX_64);
  });

  it('rejects non-object input (null / array / string / number)', () => {
    expect(() => parseSha256Checksum(null, 'c')).toThrow();
    expect(() => parseSha256Checksum([HEX_64], 'c')).toThrow();
    expect(() => parseSha256Checksum(HEX_64, 'c')).toThrow();
    expect(() => parseSha256Checksum(42, 'c')).toThrow();
  });

  it('rejects a wrong algorithm', () => {
    expect(() => parseSha256Checksum({ algorithm: 'md5', value: HEX_64 }, 'c')).toThrow();
  });

  it('rejects a non-string or malformed hex value (uppercase / short / illegal char)', () => {
    expect(() => parseSha256Checksum({ algorithm: 'sha256', value: 123 }, 'c')).toThrow();
    expect(() => parseSha256Checksum({ algorithm: 'sha256', value: 'A'.repeat(64) }, 'c')).toThrow();
    expect(() => parseSha256Checksum({ algorithm: 'sha256', value: 'a'.repeat(63) }, 'c')).toThrow();
    expect(() => parseSha256Checksum({ algorithm: 'sha256', value: 'g'.repeat(64) }, 'c')).toThrow();
  });
});

describe('sync file-key contract', () => {
  it('recognizes every declared file key and rejects unknown / non-string values', () => {
    for (const key of Object.values(SYNC_FILE_KEYS)) {
      expect(isSyncFileKey(key)).toBe(true);
    }
    expect(isSyncFileKey('memories.txt')).toBe(false);
    expect(isSyncFileKey(42)).toBe(false);
    expect(isSyncFileKey(null)).toBe(false);
  });

  it('builds a generation file key and a manifest key with the -- separator', () => {
    expect(getSyncGenerationFileKey('gen-1', SYNC_FILE_KEYS.memories))
      .toBe('sync-generation-gen-1--memories.json');
    expect(getSyncGenerationManifestKey('gen-1')).toBe('sync-generation-gen-1--manifest.json');
  });

  it('keeps required and optional keys disjoint and jointly covering all declared keys', () => {
    const required = new Set<string>(REQUIRED_SYNC_FILE_KEYS);
    const optional = new Set<string>(OPTIONAL_SYNC_FILE_KEYS);
    const overlap = [...required].filter((key) => optional.has(key));
    expect(overlap).toEqual([]);
    expect(new Set([...required, ...optional]).size).toBe(Object.values(SYNC_FILE_KEYS).length);
    for (const key of Object.values(SYNC_FILE_KEYS)) {
      expect(required.has(key) || optional.has(key)).toBe(true);
    }
  });
});
