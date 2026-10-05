import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { listZipEntries, readZipEntry, readZipMetrics } from '../scripts/zip-reader.mjs';

// The release-asset gate used to shell out to Info-ZIP's `unzip`, which is absent on
// Windows, so `npm run verify:release-assets` could only ever be green on a POSIX host.
// These fixtures pin the dependency-free reader that replaced it: the central directory
// is the only trusted source for sizes and entry offsets, because a data descriptor
// writes zeros into the local header (see the 'data descriptor' case).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntryInput {
  name: string;
  data: Buffer;
  deflated?: boolean;
  /** Write sizes as zeros in the local header and append a data descriptor. */
  dataDescriptor?: boolean;
}

function buildZip(entries: ZipEntryInput[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const payload = entry.deflated ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const flags = entry.dataDescriptor ? 0x08 : 0;
    const method = entry.deflated ? 8 : 0;
    const name = Buffer.from(entry.name, 'utf8');
    // With a data descriptor the local header carries zeros for all three fields.
    const localSizes = entry.dataDescriptor ? Buffer.alloc(12) : (() => {
      const sizes = Buffer.alloc(12);
      sizes.writeUInt32LE(crc, 0);
      sizes.writeUInt32LE(payload.byteLength, 4);
      sizes.writeUInt32LE(entry.data.byteLength, 8);
      return sizes;
    })();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12);
    localSizes.copy(local, 14);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, name, payload);
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(payload.byteLength, 8);
      descriptor.writeUInt32LE(entry.data.byteLength, 12);
      parts.push(descriptor);
    }

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x2821, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.byteLength, 20);
    header.writeUInt32LE(entry.data.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.byteLength + name.byteLength + payload.byteLength + (entry.dataDescriptor ? 16 : 0);
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBytes, end]);
}

let directoryCounter = 0;
function writeFixture(name: string, bytes: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), `dpp-zip-${directoryCounter++}-`));
  const file = join(directory, name);
  writeFileSync(file, bytes);
  return file;
}

const STORED_TEXT = Buffer.from('{"manifest_version":3}\n', 'utf8');
const REPEATABLE = Buffer.from('a'.repeat(5_000), 'utf8');

describe('release zip reader', () => {
  it('lists every central-directory entry in stored order, including directory entries', () => {
    const file = writeFixture('listing.zip', buildZip([
      { name: 'manifest.json', data: STORED_TEXT },
      { name: 'assets/', data: Buffer.alloc(0) },
      { name: 'assets/icon.js', data: Buffer.from('export const a = 1;\n', 'utf8') },
    ]));
    expect(listZipEntries(file)).toEqual(['manifest.json', 'assets/', 'assets/icon.js']);
  });

  it('returns the exact bytes of a stored entry', () => {
    const file = writeFixture('stored.zip', buildZip([{ name: 'manifest.json', data: STORED_TEXT }]));
    expect(readZipEntry(file, 'manifest.json').toString('utf8')).toBe(STORED_TEXT.toString('utf8'));
  });

  it('inflates a deflated entry', () => {
    const file = writeFixture('deflated.zip', buildZip([
      { name: 'content.js', data: REPEATABLE, deflated: true },
    ]));
    expect(readZipEntry(file, 'content.js').equals(REPEATABLE)).toBe(true);
  });

  it('takes sizes from the central directory when the local header carries a data descriptor', () => {
    const file = writeFixture('descriptor.zip', buildZip([
      { name: 'content.js', data: REPEATABLE, deflated: true, dataDescriptor: true },
      { name: 'manifest.json', data: STORED_TEXT, dataDescriptor: true },
    ]));
    expect(readZipEntry(file, 'content.js').equals(REPEATABLE)).toBe(true);
    expect(readZipEntry(file, 'manifest.json').toString('utf8')).toBe(STORED_TEXT.toString('utf8'));
  });

  it('reports raw and compressed sizes per entry from the central directory', () => {
    const file = writeFixture('metrics.zip', buildZip([
      { name: 'content.js', data: REPEATABLE, deflated: true },
      { name: 'manifest.json', data: STORED_TEXT },
    ]));
    const metrics = readZipMetrics(file);
    expect(metrics).toHaveLength(2);
    expect(metrics.find((item) => item.name === 'content.js')).toEqual({
      name: 'content.js',
      rawBytes: REPEATABLE.byteLength,
      compressedBytes: deflateRawSync(REPEATABLE).byteLength,
    });
    // A stored entry reports the same size on both sides.
    expect(metrics.find((item) => item.name === 'manifest.json')).toEqual({
      name: 'manifest.json',
      rawBytes: STORED_TEXT.byteLength,
      compressedBytes: STORED_TEXT.byteLength,
    });
  });

  it('throws with the entry name for a missing entry so the gate records a failure', () => {
    const file = writeFixture('missing.zip', buildZip([{ name: 'manifest.json', data: STORED_TEXT }]));
    expect(() => readZipEntry(file, 'package.json')).toThrow(/package\.json/);
  });

  it('throws with the file name when the archive has no end-of-central-directory record', () => {
    const file = writeFixture('broken.zip', Buffer.alloc(2_048, 0x5A));
    expect(() => listZipEntries(file)).toThrow(/broken\.zip/);
  });
});
