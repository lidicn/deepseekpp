import type { BrowserDialogState } from './types';

type DebuggerApi = typeof chrome.debugger;
type DebuggerSession = chrome.debugger.DebuggerSession;

// Dialogs are transient: entries older than this are treated as gone so a
// stale Page.javascriptDialogOpening record cannot be replayed later.
const BROWSER_DIALOG_MAX_AGE_MS = 30_000;

// #94: CDP sendCommand 默认超时。单条 CDP 命令正常应在秒级返回：
// - Runtime.evaluate（awaitPromise:true）执行恶意/失控 JS 可能永远挂住
// - Accessibility.getFullAXTree 大页面 AXTree 上千节点时较慢但应 < 10s
// 30s 给足余量；超时后抛 retryable 错误让上层决定是否重试或放弃。
const CDP_COMMAND_TIMEOUT_MS = 30_000;

export class BrowserControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class BrowserConnection {
  private readonly chromeApi: typeof chrome;
  private readonly dialogs = new Map<number, BrowserDialogState>();
  private attachedTabId: number | null = null;
  private detachListenerRegistered = false;
  private eventListenerRegistered = false;
  // 审计 #87：attach/detach/sendCommand 串行锁。并发 attach(A)/attach(B) 交错时
  // this.attachedTabId 会被后者改写，sendCommand 用错 tab。
  private attachChain: Promise<unknown> = Promise.resolve();

  constructor(chromeApi: typeof chrome) {
    this.chromeApi = chromeApi;
  }

  get tabId(): number | null {
    return this.attachedTabId;
  }

  get attached(): boolean {
    return this.attachedTabId !== null;
  }

  getLatestDialog(tabId: number): BrowserDialogState | null {
    const dialog = this.dialogs.get(tabId) ?? null;
    if (!dialog) return null;
    if (Date.now() - dialog.seenAt > BROWSER_DIALOG_MAX_AGE_MS) {
      // Dialogs are transient; a stale entry must not be replayed for a
      // dialog that has long since been dismissed (dialog entry expiry).
      this.dialogs.delete(tabId);
      return null;
    }
    // The caller is actively using this entry: refresh it so a dialog the
    // user is still reading does not expire mid-interaction. The authoritative
    // removal is Page.javascriptDialogClosed; the age window is only a
    // fallback for missed close events.
    dialog.seenAt = Date.now();
    return dialog;
  }

  clearDialog(tabId: number): void {
    this.dialogs.delete(tabId);
  }

  async attach(tabId: number): Promise<void> {
    // 审计 #87：整个 attach 过程串行化，避免并发 attach 交错改写 attachedTabId。
    const task = this.attachChain.then(() => this.attachInner(tabId));
    this.attachChain = task.catch(() => undefined);
    return task;
  }

  private async attachInner(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return;
    if (this.attachedTabId !== null) await this.detach();

    const debuggerApi = this.getDebuggerApi();
    await debuggerApi.attach({ tabId }, '1.3');
    this.attachedTabId = tabId;
    this.registerListeners();

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Page.enable');
    await this.sendCommand('DOM.enable');
    await this.sendCommand('Accessibility.enable');
    await this.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  async detach(): Promise<void> {
    if (this.attachedTabId === null) return;
    const tabId = this.attachedTabId;
    this.attachedTabId = null;
    try {
      await this.getDebuggerApi().detach({ tabId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('not attached') && !message.includes('No tab with id')) {
        throw error;
      }
    }
  }

  async sendCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    const timeoutMs = options?.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS;
    const sendPromise = this.getDebuggerApi().sendCommand(
      this.getSession(),
      method,
      params,
    ) as Promise<Record<string, unknown>>;
    const result = await Promise.race([
      sendPromise,
      new Promise<Record<string, unknown>>((_, reject) =>
        setTimeout(() => reject(new BrowserControlError(
          'browser_control_command_timeout',
          `CDP command ${method} exceeded ${timeoutMs}ms`,
          { retryable: true, details: { method, timeoutMs } },
        )), timeoutMs),
      ),
    ]);
    return (result ?? {}) as T;
  }

  /**
   * 审计 #26：释放单个 CDP objectId。best-effort —— tab 可能在 resolve 和 release 之间关闭。
   * DOM.resolveNode（按 uid 查）不带 objectGroup，所以两条路径统一逐个 release。
   * Runtime.evaluate 虽然带了 deepseek-pp-browser-control，但 releaseObjectGroup 零调用、
   * 与 DOM.resolveNode 路径不统一，本 commit 一并删除（见 service.ts 三个漏 release 的方法）。
   */
  async releaseObject(objectId: string): Promise<void> {
    try {
      await this.sendCommand('Runtime.releaseObject', { objectId });
    } catch {
      // best-effort: tab 关闭或 debugger 断开时会抛错,忽略即可。
    }
  }

  private getSession(): DebuggerSession {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    return { tabId: this.attachedTabId };
  }

  private getDebuggerApi(): DebuggerApi {
    const debuggerApi = this.chromeApi.debugger;
    if (!debuggerApi?.attach || !debuggerApi.sendCommand || !debuggerApi.detach) {
      throw new BrowserControlError(
        'debugger_api_unavailable',
        'chrome.debugger is unavailable in this extension context.',
      );
    }
    return debuggerApi;
  }

  private registerListeners(): void {
    const debuggerApi = this.getDebuggerApi();
    if (!this.detachListenerRegistered) {
      debuggerApi.onDetach.addListener((source) => {
        if (source.tabId !== this.attachedTabId) return;
        this.attachedTabId = null;
        // #81: detach 时一并清 dialogs 表 — 该 tab 已脱离 debugger，
        // 不可能再有后续 javascriptDialogClosed 事件，保留条目是内存泄漏。
        this.dialogs.delete(source.tabId);
      });
      this.detachListenerRegistered = true;
    }

    if (!this.eventListenerRegistered) {
      debuggerApi.onEvent.addListener((source, method, params) => {
        // #91: 只处理当前 attach 的 tab 事件 —— chrome.debugger.onEvent 对所有
        // attach 过的 tab 广播（哪怕是其他 BrowserConnection 实例或其他扩展），
        // 不加过滤会把子目标/其他 tab 的 dialogOpening 错误写进 this.dialogs。
        // flatten:true 后子 target 事件的 source.tabId 都是主 tabId，所以这一条
        // 守卫同时也把跨 target 的 dialog 事件路由到正确实例。
        if (!source.tabId || source.tabId !== this.attachedTabId) return;
        if (method === 'Page.javascriptDialogClosed') {
          // Authoritative removal: the browser reports the dialog is gone, so
          // the entry must not be replayed by a later handleDialog call.
          this.dialogs.delete(source.tabId);
          return;
        }
        if (method !== 'Page.javascriptDialogOpening') return;
        const payload = params as {
          type?: unknown;
          message?: unknown;
          defaultPrompt?: unknown;
        } | undefined;
        this.dialogs.set(source.tabId, {
          type: typeof payload?.type === 'string' ? payload.type : 'dialog',
          message: typeof payload?.message === 'string' ? payload.message : '',
          defaultPrompt: typeof payload?.defaultPrompt === 'string'
            ? payload.defaultPrompt
            : undefined,
          seenAt: Date.now(),
        });
      });
      this.eventListenerRegistered = true;
    }
  }
}

export function toBrowserControlError(error: unknown): BrowserControlError {
  if (error instanceof BrowserControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    message.includes('Cannot access') ||
    message.includes('No tab with id') ||
    message.includes('not attached') ||
    message.includes('detached') ||
    message.includes('target closed');
  return new BrowserControlError('browser_control_failed', message, { retryable });
}
