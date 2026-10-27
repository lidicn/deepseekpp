import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hookXHR } from '../core/interceptor/request-interceptor';
import { updateHookState } from '../core/interceptor/hook-state';
import type { ToolDescriptor } from '../core/types';
import type { DeepSeekAugmentableWebRoute } from '../core/deepseek/request-codec';
import type { RequestBodyModification } from '../core/interceptor/hook-state';

/**
 * 守护审计 #6：await onRequestBody 期间页面可能已调 xhr.abort()，
 * 此时若再 origSend 会在已 abort 的 XHR 上发出全新请求（幽灵消息/工具调用）。
 * readyState 0=UNSENT 表示已 abort 重置，直接不发。
 *
 * 目标守卫位置：src/core/interceptor/request-interceptor.ts ~L350
 *   if (xhr.readyState === 0) { return; }
 *
 * 关键设计：hookXHR 在函数闭包里捕获 `const origSend = XMLHttpRequest.prototype.send`
 * 然后覆盖 prototype.send。所以我们必须在 hookXHR 运行**之前**就把 spy 装上
 * FakeXMLHttpRequest.prototype.send，这样 hookXHR 捕获的 origSend 就是 spy。
 */
describe('request-interceptor XHR abort guard (audit #6)', () => {
  const chatBody = JSON.stringify({
    chat_session_id: 's',
    prompt: 'hi',
    parent_message_id: 1,
    model_type: null,
    thinking_enabled: false,
    search_enabled: false,
    ref_file_ids: [],
  });
  const chatUrl = 'https://chat.deepseek.com/api/v0/chat/completion';

  beforeEach(() => {
    updateHookState({
      toolDescriptors: [makeDescriptor('global')],
      onRequestBody: async () => null,
    });
  });

  it('guard fires: abort during async onRequestBody MUST suppress origSend', async () => {
    const nativeXMLHttpRequest = globalThis.XMLHttpRequest;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const FakeXMLHttpRequest = createFakeXMLHttpRequestWithAbort();
    // ⚠️ 关键：在 stubGlobal 之前先 spy prototype.send
    // hookXHR 内部会 const origSend = XMLHttpRequest.prototype.send 捕获它
    const origSendSpy = vi.spyOn(FakeXMLHttpRequest.prototype, 'send');

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      let resolveOnRequestBody!: (value: RequestBodyModification | null) => void;
      const onRequestBody = vi.fn<(
        body: string, requestId: string, route: DeepSeekAugmentableWebRoute,
      ) => Promise<RequestBodyModification | null>>(
        () => new Promise((resolve) => { resolveOnRequestBody = resolve; }),
      );
      updateHookState({ onRequestBody });

      const uninstall = hookXHR();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', chatUrl);
      xhr.send(chatBody);

      // 等待进入 onRequestBody（此时还是 pending）
      await vi.waitFor(() => expect(onRequestBody).toHaveBeenCalledOnce());
      expect(origSendSpy).not.toHaveBeenCalled(); // 还在等待 onRequestBody

      // abort 将 readyState 重置为 0
      xhr.abort();
      expect(xhr.readyState).toBe(0);

      // resolve onRequestBody → 拦截器继续到 L350 守卫
      resolveOnRequestBody(null);

      // 等待异步流程走完
      await new Promise((r) => setTimeout(r, 50));

      // 关键断言 1：abort 后 origSend 绝对不应该被调用
      expect(origSendSpy).not.toHaveBeenCalled();
      // 关键断言 2：没有意外异常
      expect(consoleError).not.toHaveBeenCalled();

      uninstall();
    } finally {
      vi.stubGlobal('XMLHttpRequest', nativeXMLHttpRequest);
      consoleError.mockRestore();
    }
  });

  it('negative control: without abort, origSend IS called once', async () => {
    const nativeXMLHttpRequest = globalThis.XMLHttpRequest;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const FakeXMLHttpRequest = createFakeXMLHttpRequestWithAbort();
    const origSendSpy = vi.spyOn(FakeXMLHttpRequest.prototype, 'send');

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      let resolveOnRequestBody!: (value: RequestBodyModification | null) => void;
      const onRequestBody = vi.fn<(
        body: string, requestId: string, route: DeepSeekAugmentableWebRoute,
      ) => Promise<RequestBodyModification | null>>(
        () => new Promise((resolve) => { resolveOnRequestBody = resolve; }),
      );
      updateHookState({ onRequestBody });

      const uninstall = hookXHR();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', chatUrl);
      xhr.send(chatBody);

      await vi.waitFor(() => expect(onRequestBody).toHaveBeenCalledOnce());

      // 注意：此时 Fake.send() 还没跑（被拦截器的异步路径挂起），
      // readyState 停留在 open() 设的 1。abort 之后它变成 0。
      resolveOnRequestBody(null);

      await new Promise((r) => setTimeout(r, 50));

      // 关键断言：正常路径 origSend 被调用一次
      expect(origSendSpy).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();

      uninstall();
    } finally {
      vi.stubGlobal('XMLHttpRequest', nativeXMLHttpRequest);
      consoleError.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// FakeXMLHttpRequest —— 具备 abort() 将 readyState 重置为 0 的最小实现
// 参考 fetch-hook-request-lifecycle.test.ts 的 createFakeXMLHttpRequest
// ---------------------------------------------------------------------------

function createFakeXMLHttpRequestWithAbort() {
  return class FakeXMLHttpRequest extends EventTarget {
    readyState = 0;
    responseType: XMLHttpRequestResponseType = '';
    status = 0;
    sentBody: Document | XMLHttpRequestBodyInit | null | undefined;

    get responseText() { return ''; }
    get response() { return ''; }

    open(_method: unknown, _url: unknown) {
      this.readyState = 1;
      this.dispatchEvent(new Event('readystatechange'));
    }

    setRequestHeader(_name: string, _value: string) {}

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      this.sentBody = body;
      this.status = 200;
      this.readyState = 4; // DONE
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new Event('load'));
    }

    /**
     * 模拟真实 XHR.abort()：将 readyState 重置为 0 (UNSENT)，
     * 这就是 request-interceptor L350 守卫要检测的标志位。
     */
    abort() {
      this.readyState = 0;
      this.dispatchEvent(new Event('abort'));
    }
  } as unknown as typeof XMLHttpRequest;
}

function makeDescriptor(id: string): ToolDescriptor {
  return {
    id: `local:test:${id}`,
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name: id,
    invocationName: id,
    title: id,
    description: id,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}
