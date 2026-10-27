import { describe, expect, it } from 'vitest';
import { createConversationExportArchiveArtifact } from '../core/export/zip';

function artifact(filename: string) {
  return {
    format: 'html' as const,
    filename,
    mimeType: 'text/html;charset=utf-8' as const,
    content: '<p>x</p>',
  };
}

describe('audit #100 guard: ZIP entry filename must not allow path traversal (Zip Slip)', () => {
  it('rejects ../ escape attempt — classic Zip Slip', () => {
    expect(() => createConversationExportArchiveArtifact([artifact('../../escape.txt')]))
      .toThrow(/path traversal/);
  });

  it('rejects absolute /etc/ path', () => {
    expect(() => createConversationExportArchiveArtifact([artifact('/etc/passwd')]))
      .toThrow(/must not be absolute/);
  });

  it('rejects absolute \\Windows\\ path (backslash)', () => {
    expect(() => createConversationExportArchiveArtifact([artifact('\\Windows\\System32\\evil.txt')]))
      .toThrow(/must not be absolute/);
  });

  it('rejects mid-path .. traversal', () => {
    expect(() => createConversationExportArchiveArtifact([artifact('safe/../../outside.txt')]))
      .toThrow(/path traversal/);
  });

  it('rejects backslash separators', () => {
    expect(() => createConversationExportArchiveArtifact([artifact('evil\\traversal.txt')]))
      .toThrow(/must not contain backslashes/);
  });

  it('accepts normal safe filenames (regression guard)', () => {
    // These are the legitimate filenames the real export produces
    expect(() => createConversationExportArchiveArtifact([
      artifact('deepseek-conversations-2026-10-28.html'),
      artifact('reports/sanitized.md'),
    ])).not.toThrow();
  });

  it('accepts nested subdirectory paths (no traversal)', () => {
    expect(() => createConversationExportArchiveArtifact([
      artifact('conversations/2026/archive.md'),
    ])).not.toThrow();
  });
});
