import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('audit #86 guard: multimodal handlers must not crash on missing media data', () => {
  let createMultimodalRuntimeHandlers: typeof import('../entrypoints/background/multimodal-handlers')['createMultimodalRuntimeHandlers'];
  let makeDeps: () => any;
  let callAnalyze: (handlers: any, payload: unknown, tabId?: number) => Promise<any>;

  beforeEach(async () => {
    vi.resetModules();

    // Mock the entire core/multimodal so that:
    //   1) normalizeMultimodalMediaAnalyzeRequest yields malformed items (no dataUrl/base64Data)
    //   2) MCP server availability checks pass
    vi.doMock('../core/multimodal', async () => ({
      canUseMultimodalMediaInput: () => true,
      isMultimodalAnalysisToolAllowed: () => true,
      isMultimodalMcpServer: () => true,
    }));

    vi.doMock('../core/multimodal/media', async () => {
      const actual = await vi.importActual('../core/multimodal/media');
      return {
        ...actual,
        // Simulate a bypassed normalization — items pass shape check but are missing body data
        normalizeMultimodalMediaAnalyzeRequest: vi.fn(async (value: any) => {
          const media = Array.isArray(value?.media) ? value.media : [];
          return { prompt: value?.prompt ?? 'analyze', media };
        }),
      };
    });

    const mod = await import('../entrypoints/background/multimodal-handlers');
    createMultimodalRuntimeHandlers = mod.createMultimodalRuntimeHandlers;

    makeDeps = () => ({
      getSettingsStatus: vi.fn(async () => ({
        openaiConfigured: true, geminiConfigured: true,
        openaiImageModel: 'gpt-4', geminiVideoModel: 'gemini-2.5',
        openaiBaseUrl: 'https://api.openai.com/v1', geminiBaseUrl: 'https://gvl.api',
      })),
      saveSettings: vi.fn(async () => ({})),
      clearSettings: vi.fn(async () => ({})),
      getMcpServers: vi.fn(async () => [
        {
          id: 'mmcp', displayName: 'Multimodal MCP',
          transport: { kind: 'stdio' }, enabled: true,
          execution: { enabled: true, mode: 'command', command: 'mcp', args: [] },
          allowlist: [],
        },
      ]),
      executeToolCall: vi.fn(async () => ({ ok: true, summary: 'ok' })),
      broadcastToolCallHistoryUpdate: vi.fn(async () => undefined),
    });

    callAnalyze = async (handlers, payload, tabId = 17) => {
      const handler = handlers.find((h: any) => h.type === 'ANALYZE_MULTIMODAL_MEDIA');
      return handler.handle!({ type: 'ANALYZE_MULTIMODAL_MEDIA', payload }, { tabId } as any);
    };
  });

  it('returns ok:false with error when image item has no dataUrl (no !non-null crash)', async () => {
    const deps = makeDeps();
    const handlers = createMultimodalRuntimeHandlers(deps);

    const result = await callAnalyze(handlers, {
      prompt: 'describe',
      media: [
        {
          id: 'img-1', kind: 'image', name: 'photo.png',
          mimeType: 'image/png', sizeBytes: 1024,
          // dataUrl INTENTIONALLY missing — would have been caught by
          // assertMultimodalMediaBody, but we bypass that via mock
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('image data is missing');
    expect(deps.executeToolCall).not.toHaveBeenCalled();
  });

  it('returns ok:false with error when video item has no base64Data (no !non-null crash)', async () => {
    const deps = makeDeps();
    const handlers = createMultimodalRuntimeHandlers(deps);

    const result = await callAnalyze(handlers, {
      prompt: 'summarize',
      media: [
        {
          id: 'vid-1', kind: 'video', name: 'clip.mp4',
          mimeType: 'video/mp4', sizeBytes: 2048,
          // base64Data INTENTIONALLY missing
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('video data is missing');
    expect(deps.executeToolCall).not.toHaveBeenCalled();
  });
});
