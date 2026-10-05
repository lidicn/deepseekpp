import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// Dependency-free ZIP reader for the release-asset gate.
//
// The gate shelled out to Info-ZIP's `unzip`, which is not installed on Windows, so
// `npm run verify:release-assets` could never go green on the maintainer's own machine.
// Sizes and offsets are taken from the central directory, never from the local header:
// a data descriptor (general flag bit 3) writes zeros into the local header, so only
// the central record is authoritative. See tests/release-zip-reader.test.ts.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const ZIP64_EOCD_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const EOCD_BYTES = 22;
const MAX_EOCD_SEARCH_BYTES = EOCD_BYTES + 0xFFFF;
const SENTINEL_16 = 0xffff;
const SENTINEL_32 = 0xffffffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Entry names in central-directory order, including directory records. */
export function listZipEntries(zipFile) {
  return readCentralDirectory(zipFile).map((entry) => entry.name);
}

/** Decompressed bytes of one entry. Throws when the entry is absent. */
export function readZipEntry(zipFile, entryName) {
  const entries = readCentralDirectory(zipFile);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (!entry) throw new Error(`${zipFile}: no such zip entry: ${entryName}`);
  return withFileHandle(zipFile, (descriptor) => readEntryBytes(descriptor, entry, zipFile));
}

/** Per-entry byte sizes: raw (uncompressed) and compressed, as the budget checks need. */
export function readZipMetrics(zipFile) {
  return readCentralDirectory(zipFile).map(({ name, rawBytes, compressedBytes }) => ({
    name,
    rawBytes,
    compressedBytes,
  }));
}

function withFileHandle(zipFile, run) {
  const descriptor = openSync(zipFile, 'r');
  try {
    return run(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readAt(descriptor, position, length, zipFile, what) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`${zipFile}: truncated archive while reading ${what}`);
  }
  return buffer;
}

function findEndOfCentralDirectory(descriptor, fileSize, zipFile) {
  const searchLength = Math.min(fileSize, MAX_EOCD_SEARCH_BYTES);
  const searchPosition = fileSize - searchLength;
  const tail = readAt(descriptor, searchPosition, searchLength, zipFile, 'the end-of-central-directory record');
  for (let index = tail.length - EOCD_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const commentBytes = tail.readUInt16LE(index + 20);
    if (index + EOCD_BYTES + commentBytes !== tail.length) continue;
    return { record: tail.subarray(index), absolutePosition: searchPosition + index };
  }
  throw new Error(`${zipFile}: no end-of-central-directory record (not a zip archive?)`);
}

function readArchiveLayout(descriptor, fileSize, zipFile) {
  const { record, absolutePosition } = findEndOfCentralDirectory(descriptor, fileSize, zipFile);
  let entryCount = record.readUInt16LE(10);
  let centralBytes = record.readUInt32LE(12);
  let centralPosition = record.readUInt32LE(16);

  if (
    entryCount === SENTINEL_16
    || centralBytes === SENTINEL_32
    || centralPosition === SENTINEL_32
  ) {
    const locatorPosition = absolutePosition - ZIP64_LOCATOR_BYTES;
    if (locatorPosition < 0) {
      throw new Error(`${zipFile}: ZIP64 archive without a locator record`);
    }
    const locator = readAt(descriptor, locatorPosition, ZIP64_LOCATOR_BYTES, zipFile, 'the ZIP64 end-of-central-directory locator');
    if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new Error(`${zipFile}: ZIP64 archive without a locator record`);
    }
    const zip64Position = Number(locator.readBigUInt64LE(8));
    const zip64 = readAt(descriptor, zip64Position, ZIP64_EOCD_BYTES, zipFile, 'the ZIP64 end-of-central-directory record');
    if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error(`${zipFile}: ZIP64 end-of-central-directory record is missing`);
    }
    entryCount = Number(zip64.readBigUInt64LE(32));
    centralBytes = Number(zip64.readBigUInt64LE(40));
    centralPosition = Number(zip64.readBigUInt64LE(48));
  }

  return { entryCount, centralBytes, centralPosition };
}

function parseCentralRecord(record, zipFile) {
  if (record.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
    throw new Error(`${zipFile}: malformed central-directory record`);
  }
  const method = record.readUInt16LE(10);
  const compressedBytes = record.readUInt32LE(20);
  const rawBytes = record.readUInt32LE(24);
  const nameBytes = record.readUInt16LE(28);
  const extraBytes = record.readUInt16LE(30);
  const commentBytes = record.readUInt16LE(32);
  const localHeaderPosition = record.readUInt32LE(42);
  if (
    compressedBytes === SENTINEL_32
    || rawBytes === SENTINEL_32
    || localHeaderPosition === SENTINEL_32
  ) {
    throw new Error(`${zipFile}: ZIP64 per-entry sizes are not supported by the release gate`);
  }
  const nameStart = CENTRAL_HEADER_BYTES;
  return {
    entry: {
      name: record.subarray(nameStart, nameStart + nameBytes).toString('utf8'),
      method,
      compressedBytes,
      rawBytes,
      localHeaderPosition,
    },
    recordBytes: CENTRAL_HEADER_BYTES + nameBytes + extraBytes + commentBytes,
  };
}

function readCentralDirectory(zipFile) {
  return withFileHandle(zipFile, (descriptor) => {
    const fileSize = fstatSync(descriptor).size;
    const { entryCount, centralBytes, centralPosition } = readArchiveLayout(descriptor, fileSize, zipFile);
    const block = readAt(descriptor, centralPosition, centralBytes, zipFile, 'the central directory');
    const entries = [];
    let offset = 0;
    while (offset < block.length) {
      const { entry, recordBytes } = parseCentralRecord(block.subarray(offset), zipFile);
      entries.push(entry);
      offset += recordBytes;
    }
    if (entries.length !== entryCount) {
      throw new Error(`${zipFile}: central directory holds ${entries.length} of ${entryCount} recorded entries`);
    }
    return entries;
  });
}

function readEntryBytes(descriptor, entry, zipFile) {
  const local = readAt(descriptor, entry.localHeaderPosition, LOCAL_HEADER_BYTES, zipFile, 'a local file header');
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`${zipFile}: local header for ${entry.name} is missing`);
  }
  const dataPosition = entry.localHeaderPosition
    + LOCAL_HEADER_BYTES
    + local.readUInt16LE(26)
    + local.readUInt16LE(28);
  const stored = readAt(descriptor, dataPosition, entry.compressedBytes, zipFile, `the payload of ${entry.name}`);
  if (entry.method === METHOD_STORE) return stored;
  if (entry.method === METHOD_DEFLATE) return inflateRawSync(stored);
  throw new Error(`${zipFile}: unsupported compression method ${entry.method} for ${entry.name}`);
}
