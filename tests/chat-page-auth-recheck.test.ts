/**
 * 第十二批 P0-1 · ChatPage：认证失败→重试成功后必须渲染 textarea。
 *
 * 变异：把 loadAuthStatusWithRetry 的 delays 置空（等价重试 0 次）⇒ 本用例红。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatControllerMock = vi.hoisted(() => ({
  load: vi.fn(),
  refreshAuthStatus: vi.fn(),
  saveConfig: vi.fn(),
  submitPrompt: vi.fn(),
  newSession: vi.fn(),
  setWebModelType: vi.fn(),
  uploadImage: vi.fn(),
}));

vi.mock('../entrypoints/sidepanel/controllers/chat-controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../entrypoints/sidepanel/controllers/chat-controller')>();
  return {
    ...actual,
    chatController: chatControllerMock,
  };
});

vi.mock('../entrypoints/sidepanel/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en' as const,
  }),
}));

vi.mock('../entrypoints/sidepanel/pending-text', () => ({
  consumePendingText: () => null,
  onPendingText: () => () => {},
}));

vi.mock('../entrypoints/sidepanel/trusted-directory', () => ({
  getTrustedDirectorySession: () => null,
}));

vi.mock('../core/chat/active-transcript', () => ({
  readTranscript: () => ({
    status: 'idle',
    messages: [],
    pendingChunks: [],
    lastSeq: 0,
    chatSessionId: null,
  }),
  addUserMessage: vi.fn(),
  clearTranscript: vi.fn(),
  getLastWriteError: () => null,
}));

const ChatPage = (await import('../entrypoints/sidepanel/pages/ChatPage')).default;

let container: HTMLDivElement;
let root: Root | null;

function auth(hasToken: boolean) {
  return {
    available: hasToken,
    provider: hasToken ? 'deepseek-web' : null,
    hasApiKey: false,
    hasToken,
  };
}

const idleSnapshot = (authStatus: ReturnType<typeof auth>) => ({
  authStatus,
  chatConfig: {
    model: 'deepseek-v4-flash',
    thinking: 'disabled',
    reasoningEffort: 'high',
  },
  webModelType: null,
  voiceSettings: {
    inputEnabled: false,
    readAloudEnabled: false,
    rate: 1,
    pitch: 1,
  },
  loadErrors: [],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChatPage auth recovery', () => {
  it('first load unavailable, recheck available ⇒ textarea appears (no full reload)', async () => {
    vi.useFakeTimers();
    chatControllerMock.load.mockResolvedValue(idleSnapshot(auth(false)));
    chatControllerMock.refreshAuthStatus.mockResolvedValue(auth(true));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ChatPage));
    });

    // load() 完成后：无 token ⇒ 显示认证空态 + 重新检测按钮
    expect(container.querySelector('[data-testid="chat-auth-empty"]')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();

    await act(async () => {
      const button = container.querySelector('[data-testid="chat-auth-recheck"]');
      expect(button).not.toBeNull();
      (button as HTMLButtonElement).click();
    });

    expect(chatControllerMock.refreshAuthStatus).toHaveBeenCalledTimes(1);
    // 重新检测成功后必须出现输入框
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-auth-empty"]')).toBeNull();
  });

  it('load already has token ⇒ textarea without recheck', async () => {
    chatControllerMock.load.mockResolvedValue(idleSnapshot(auth(true)));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ChatPage));
    });

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(chatControllerMock.refreshAuthStatus).not.toHaveBeenCalled();
  });
});
