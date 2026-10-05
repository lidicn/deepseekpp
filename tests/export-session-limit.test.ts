/**
 * Conversation export session cap (DPP-01, ruling A).
 *
 * Audit report #15: an export request without `sessionLimit` paged the official
 * session list until the account ran out, holding every session in memory. The
 * ruling is a default cap of 500 plus "the user must be told", never a silent
 * short export:
 *   - the cap is filled in at the normalize boundary, so every caller — including
 *     the runtime command surface, whose input is untrusted — gets a bounded request
 *   - the transport receives that number, and only that number bounds the paging loop
 *   - a run that filled the cap says so in the stats and in the artifacts
 *   - the value is a user-facing setting (sidepanel), defaulting to 500, and the
 *     stored cap governs a listing export instead of the page-side caller
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildConversationExportArtifacts,
  runConversationExport,
} from '../core/export/service';
import {
  ConversationExportValidationError,
  DEFAULT_CONVERSATION_EXPORT_SESSION_LIMIT,
  normalizeConversationExportRequest,
} from '../core/export/schema';
import { applyStoredSessionLimit } from '../core/export/session-limit';
import type { ConversationExportTransport } from '../core/export/service';
import type { DeepSeekSessionSummary } from '../core/export/normalize';

function sessionSummary(id: string): DeepSeekSessionSummary {
  return {
    id,
    title: id,
    pinned: false,
    titleType: null,
    modelType: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** One user row + one assistant row: enough for the artifacts to render. */
function historyFixture(title: string) {
  return {
    data: {
      biz_data: {
        chat_messages: [
          {
            id: 1,
            message_role: 'user',
            created_at: 1760000001,
            fragments: [{ type: 'REQUEST', content: `提问：${title}` }],
          },
          {
            id: 2,
            parent_id: 1,
            message_role: 'assistant',
            created_at: 1760000002,
            fragments: [{ type: 'RESPONSE', content: `回答：${title}` }],
          },
        ],
      },
    },
  };
}

function stubTransport(sessionIds: string[]): ConversationExportTransport & {
  listInputs: Array<{ pageSize: number; sessionLimit?: number }>;
} {
  const listInputs: Array<{ pageSize: number; sessionLimit?: number }> = [];
  return {
    listInputs,
    async listSessions(input) {
      listInputs.push({ pageSize: input.pageSize, sessionLimit: input.sessionLimit });
      return sessionIds.map(sessionSummary);
    },
    async fetchHistory({ session }) {
      return historyFixture(session.id);
    },
    async fetchFiles() {
      return [];
    },
  };
}

async function runExport(request: Record<string, unknown>, transport: ConversationExportTransport) {
  return runConversationExport({
    exportId: 'export-cap-test',
    extensionVersion: '0.0.0-test',
    baseUrl: 'https://chat.deepseek.com',
    request,
    transport,
  });
}

describe('conversation export session limit', () => {
  it('fills the 500-session default at the normalize boundary', () => {
    expect(DEFAULT_CONVERSATION_EXPORT_SESSION_LIMIT).toBe(500);
    expect(normalizeConversationExportRequest({}).sessionLimit).toBe(500);
    expect(normalizeConversationExportRequest({ sessionLimit: 12 }).sessionLimit).toBe(12);
  });

  it('rejects a non-positive or fractional cap instead of widening scope', () => {
    expect(() => normalizeConversationExportRequest({ sessionLimit: 0 }))
      .toThrow(ConversationExportValidationError);
    expect(() => normalizeConversationExportRequest({ sessionLimit: 2.5 }))
      .toThrow(ConversationExportValidationError);
  });

  it('hands the transport the default cap when the caller omitted one', async () => {
    const transport = stubTransport(['session-alpha', 'session-beta']);
    const exportData = await runExport({ formats: ['markdown'] }, transport);

    expect(transport.listInputs).toEqual([{ pageSize: 50, sessionLimit: 500 }]);
    expect(exportData.request.sessionLimit).toBe(500);
  });

  it('reports a run that filled its cap as truncated', async () => {
    const transport = stubTransport(['session-alpha', 'session-beta']);
    const exportData = await runExport(
      { formats: ['markdown'], pageSize: 2, sessionLimit: 2 },
      transport,
    );

    expect(exportData.stats.sessionCount).toBe(2);
    expect(exportData.stats.truncatedBySessionLimit).toBe(true);
  });

  it('does not claim truncation when the account ran dry below the cap', async () => {
    const transport = stubTransport(['session-alpha']);
    const exportData = await runExport(
      { formats: ['markdown'], pageSize: 2, sessionLimit: 5 },
      transport,
    );

    expect(exportData.stats.sessionCount).toBe(1);
    expect(exportData.stats.truncatedBySessionLimit).toBeFalsy();
  });

  it('names the cap in the exported artifacts instead of silently shortening them', async () => {
    const transport = stubTransport(['session-alpha', 'session-beta']);
    const exportData = await runExport(
      { formats: ['html', 'markdown'], pageSize: 2, sessionLimit: 2 },
      transport,
    );

    const artifacts = buildConversationExportArtifacts(exportData);
    const html = artifacts.find((artifact) => artifact.format === 'html')?.content ?? '';
    const markdown = artifacts.find((artifact) => artifact.format === 'markdown')?.content ?? '';

    expect(html).toContain('stopped at the session limit');
    expect(html).toContain('2');
    expect(markdown).toContain('stopped at the session limit');
    expect(markdown).toContain('export it in smaller ranges');
  });

  it('leaves the cap notice out of a complete export', async () => {
    const transport = stubTransport(['session-alpha']);
    const exportData = await runExport(
      { formats: ['html'], pageSize: 2, sessionLimit: 5 },
      transport,
    );

    const html = buildConversationExportArtifacts(exportData)[0].content;
    expect(html).not.toContain('stopped at the session limit');
  });

  it('keeps explicit-session exports out of the capped listing', async () => {
    const transport = stubTransport(['should-not-be-listed']);
    const exportData = await runExport(
      { formats: ['markdown'], sessionIds: ['session-alpha'] },
      transport,
    );

    expect(transport.listInputs).toEqual([]);
    expect(exportData.stats.truncatedBySessionLimit).toBeFalsy();
    expect(exportData.sessions[0].id).toBe('session-alpha');
  });
});

describe('export session limit setting wiring', () => {
  it('lets the stored cap govern a listing export', () => {
    expect(applyStoredSessionLimit(normalizeConversationExportRequest({ formats: ['html'] }), 800))
      .toMatchObject({ sessionLimit: 800 });
    expect(applyStoredSessionLimit(normalizeConversationExportRequest({ formats: ['html'] }), null))
      .toMatchObject({ sessionLimit: 500 });
  });

  it('keeps an explicit-session request out of the stored cap', () => {
    const request = normalizeConversationExportRequest({ formats: ['html'], sessionIds: ['session-alpha'] });
    expect(applyStoredSessionLimit(request, 800)).toBe(request);
  });

  it('applies the stored cap in the background export handler', () => {
    const source = readFileSync(
      join(process.cwd(), 'entrypoints/background/conversation-export-handlers.ts'),
      'utf8',
    );
    expect(source).toMatch(/loadSessionLimit/);
    expect(source).toMatch(/applyStoredSessionLimit/);
  });

  it('reads the cap from chrome.storage.local in the background wiring', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/background.ts'), 'utf8');
    expect(source).toMatch(/readConversationExportSessionLimit/);
  });

  it('exposes the cap as a sidepanel number setting with localized copy', () => {
    const controller = readFileSync(
      join(process.cwd(), 'entrypoints/sidepanel/controllers/useSettingsController.ts'),
      'utf8',
    );
    expect(controller).toMatch(/CONVERSATION_EXPORT_SESSION_LIMIT_STORAGE_KEY/);
    expect(controller).toMatch(/handleExportSessionLimitChange/);

    const page = readFileSync(
      join(process.cwd(), 'entrypoints/sidepanel/components/settings/DataSubPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/t\(['"]sidepanel\.settings\.exportSessionLimit['"]\)/);
    expect(page).toMatch(/state\.handleExportSessionLimitChange/);
  });
});
