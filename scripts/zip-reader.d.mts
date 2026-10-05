import type { Buffer } from 'node:buffer';

export function listZipEntries(zipFile: string): string[];
export function readZipEntry(zipFile: string, entryName: string): Buffer;
export interface ZipEntryMetrics {
  name: string;
  rawBytes: number;
  compressedBytes: number;
}
export function readZipMetrics(zipFile: string): ZipEntryMetrics[];
