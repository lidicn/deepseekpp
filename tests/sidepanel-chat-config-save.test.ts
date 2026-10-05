import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPage from '../entrypoints/sidepanel/pages/ChatPage';

let container: HTMLDivElement;
let root: Root | null;
let runtimeListeners: Array<(message: unknown) => void>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  runtimeListeners = [];
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
});

interface PendingSave {
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function stubChatRuntime(): { sendMessage: ReturnType<typeof vi.fn>; pendingSaves: PendingSave[] } {
  const pendingSaves: PendingSave[] = [];
  const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
    if (message.type === 'GET_AUTH_STATUS') {
      return { available: true, provider: 'official-api', hasApiKey: true };
    }
    if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
    if (message.type === 'GET_MODEL_TYPE') return null;
    if (message.type === 'GET_VOICE_SETTINGS') return {};
    if (message.type === 'SAVE_OFFICIAL_API_CHAT_CONFIG') {
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pendingSaves.push({ payload: message.payload, resolve, reject });
      return promise;
    }
    return null;
  });
  stubChrome(sendMessage);
  return { sendMessage, pendingSaves };
}

describe('sidepanel chat config save races', () => {
  it('does not let a slower older save response overwrite the newer config', async () => {
    const { pendingSaves } = stubChatRuntime();
    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    expect(segmentActive('Flash')).toBe(true);

    // Two rapid saves: the model first goes to Pro, then back to Flash.
    await clickSegment('Pro');
    await clickSegment('Flash');
    expect(pendingSaves.map((save) => (save.payload as { model: string }).model))
      .toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);

    // The newer save answers first.
    await act(async () => {
      pendingSaves[1].resolve(pendingSaves[1].payload);
      await Promise.resolve();
    });
    expect(segmentActive('Flash')).toBe(true);

    // The stale earlier response lands last and must not win.
    await act(async () => {
      pendingSaves[0].resolve(pendingSaves[0].payload);
      await Promise.resolve();
    });
    expect(segmentActive('Flash')).toBe(true);
    expect(segmentActive('Pro')).toBe(false);
  });

  it('restores the previous config when a save fails', async () => {
    const { pendingSaves } = stubChatRuntime();
    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    await clickSegment('Pro');
    expect(segmentActive('Pro')).toBe(true);

    await act(async () => {
      pendingSaves[0].reject(new Error('save failed'));
      await Promise.resolve();
    });

    expect(segmentActive('Flash')).toBe(true);
    expect(segmentActive('Pro')).toBe(false);
    expect(container.textContent).toContain('save failed');
  });
});

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
}

function stubChrome(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners = runtimeListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
}

async function clickSegment(label: string) {
  const button = Array.from(container.querySelectorAll('button.ds-chat-segment'))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function segmentActive(label: string): boolean {
  const button = Array.from(container.querySelectorAll('button.ds-chat-segment'))
    .find((candidate) => candidate.textContent === label);
  return Boolean(button?.className.includes('ds-chat-segment-active'));
}

async function flushPromises() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}
