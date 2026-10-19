import { describe, expect, it } from 'vitest';
import {
  createConversationExportHtmlArtifact,
  renderConversationExportHtml,
} from '../core/export/artifact-html';
import {
  createConversationExportMarkdownArtifact,
  renderConversationExportMarkdown,
} from '../core/export/artifact-markdown';
import type {
  ConversationExport,
  ExportedContentFragment,
  ExportedMessage,
  ExportedSession,
} from '../core/export/types';

// T44: markdown/html 导出的纯字符串边界——空内容回退、HTML 特殊字符转义、
// markdown 标题清洗、warnings 渲染、超长内容不崩。两模块无 Blob/URL 依赖，直接测字符串。

function buildExport(overrides: Partial<ConversationExport> = {}): ConversationExport {
  return {
    schemaVersion: 'deepseek-pp.conversation-export.v1',
    exportId: 'fmt-test',
    createdAt: '2026-10-20T00:00:00.000Z',
    source: {
      provider: 'deepseek-official-web',
      baseUrl: 'https://chat.deepseek.com',
      endpointVerification: 'static-bundle-and-browser-session',
      fileBodies: 'unsupported-unverified',
    },
    generatedBy: { name: 'DeepSeek++', version: '0.0.0-test' },
    request: {
      mode: 'sanitized',
      contentScope: 'full',
      formats: ['markdown', 'html'],
      includeAttachmentMetadata: true,
      includeFileBodies: false,
    },
    stats: { sessionCount: 1, messageCount: 1, attachmentCount: 0, failedSessionCount: 0, startedAt: '', completedAt: '' },
    sessions: [],
    attachments: [],
    failures: [],
    ...overrides,
  };
}

function oneSession(title: string, content: string): ExportedSession[] {
  const message: ExportedMessage = {
    id: 'm1',
    parentId: null,
    role: 'user',
    content,
    contentFragments: [] as ExportedContentFragment[],
    createdAt: null,
    updatedAt: null,
    modelType: null,
    searchEnabled: null,
    thinkingEnabled: null,
    attachmentRefs: [],
  };
  return [{
    id: 's1',
    title,
    pinned: false,
    titleType: null,
    modelType: null,
    createdAt: null,
    updatedAt: null,
    messages: [message],
    failures: [],
  }];
}

describe('renderConversationExportHtml · escaping and empty fallback', () => {
  it('escapes < > & " \' in message content', () => {
    const evil = `<script>alert("x")</script> & 'quoted'`;
    const html = renderConversationExportHtml(buildExport({ sessions: oneSession('t', evil) }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;x&quot;');
    expect(html).toContain('&#39;quoted&#39;');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it('falls back to "No text content" for an empty message', () => {
    const html = renderConversationExportHtml(buildExport({ sessions: oneSession('t', '') }));
    expect(html).toContain('No text content');
  });
});

describe('renderConversationExportMarkdown · heading cleaning and empty fallback', () => {
  it('strips leading # marks and collapses whitespace in the session title', () => {
    const md = renderConversationExportMarkdown(buildExport({ sessions: oneSession('###  我的   标题 ', 'hi') }));
    expect(md).toContain('## 我的 标题');
    expect(md).not.toContain('### 我的   标题');
  });

  it('falls back to 未命名对话 for an empty title and _No text content_ for empty body', () => {
    const md = renderConversationExportMarkdown(buildExport({ sessions: oneSession('', '') }));
    expect(md).toContain('未命名对话');
    expect(md).toContain('_No text content_');
  });
});

describe('warnings render in both formats', () => {
  it('renders top-level failures as Export Warnings (md) and .warning block (html)', () => {
    const data = buildExport({
      failures: [{ code: 'FETCH_FAILED', message: 'boom', retryable: true }],
    });
    expect(renderConversationExportMarkdown(data)).toContain('Export Warnings');
    expect(renderConversationExportMarkdown(data)).toContain('FETCH_FAILED: boom');
    const html = renderConversationExportHtml(data);
    expect(html).toContain('class="warning"');
    expect(html).toContain('FETCH_FAILED: boom');
  });
});

describe('empty export and long content', () => {
  it('renders a valid shell with no sessions or attachments', () => {
    const html = renderConversationExportHtml(buildExport());
    expect(html.trimStart().startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('Attachment Manifest');
    expect(renderConversationExportMarkdown(buildExport())).toContain('DeepSeek Conversation Export');
  });

  it('does not truncate or throw on a very long message body', () => {
    const long = 'x'.repeat(10_000);
    const html = renderConversationExportHtml(buildExport({ sessions: oneSession('t', long) }));
    expect(html).toContain('x'.repeat(100));
    expect(renderConversationExportMarkdown(buildExport({ sessions: oneSession('t', long) })).length).toBeGreaterThan(10_000);
  });
});

describe('create*Artifact metadata', () => {
  it('sets format/mimeType for markdown and html', () => {
    const md = createConversationExportMarkdownArtifact(buildExport());
    expect(md.format).toBe('markdown');
    expect(md.mimeType).toContain('text/markdown');
    const html = createConversationExportHtmlArtifact(buildExport());
    expect(html.format).toBe('html');
    expect(html.mimeType).toContain('text/html');
  });
});
