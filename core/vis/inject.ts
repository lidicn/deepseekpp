/**
 * S7 注入层：把模型输出里的 `vis-json` 代码块渲染成卡片。
 *
 * 三态（流式体验的关键）：
 *   · **pending**：围栏还没闭合 ⇒ 先把裸 JSON 换成**骨架卡**（原来用户全程盯着半截 JSON）
 *   · **complete**：闭合且渲染成功 ⇒ 换成真卡
 *   · **failed**：版本不符/结构性失败 ⇒ **还原原始代码块**（宁可给原文，也不给空白卡）
 *
 * 其余约束（每条对应一个已知失败模式）：
 * 1. 只碰助手回合（锚 `.ds-markdown`）；判据双通道（类名或内容嗅探）
 * 2. 样式隔离：Shadow DOM + buildVisCss({scope:':host'})
 * 3. 幂等 + 可回收；`enabled:false` 时 start() 空操作
 * 4. 监听面收窄：body 只盯 childList 发现新回合，内容更新只对已发现的回合挂深度监听；
 *    真正拦住误触发的是 `isRelevant` 谓词（选项收窄是成本优化，单测不可观测）
 */

import type { ImageResolver } from './image-resolver';
import { renderToHtml } from './render';
import { buildVisCss } from './theme';
import type { RenderOutcome } from './types';

const VIS_LANGUAGE_CLASS = 'vis-json';
const ASSISTANT_ROOT_SELECTOR = '.ds-markdown';
const CODE_SELECTOR = 'pre > code';
const HOST_CLASS = 'dppvis-host';
const PENDING_CLASS = 'dppvis-host--pending';
const STATE_ATTR = 'data-dppvis-state';
const SNIFF = /^\s*\{\s*"v"\s*:\s*1\b/;

export interface VisInjectorOptions {
  enabled: boolean;
  document: Document;
  imageResolver?: ImageResolver;
  theme?: 'light' | 'dark';
  /** 扫描去抖窗口，默认 250ms。 */
  debounceMs?: number;
  /** 流式期是否给骨架卡（默认 true）。关掉则保持原始代码块直到闭合。 */
  showPendingSkeleton?: boolean;
  roots?: ParentNode[];
  onOutcome?: (outcome: RenderOutcome, code: Element) => void;
}

export interface VisInjector {
  start(): void;
  stop(): void;
  scan(): number;
  mountedCount(): number;
  /** 当前处于 pending（流式中）的块数。 */
  pendingCount(): number;
  dispose(): void;
}

interface Mounted {
  host: HTMLElement;
  code: Element;
  source: string;
}

interface Pending {
  host: HTMLElement;
  /** 被替换下来的原始 <pre>：失败时要还原回去。 */
  pre: Element;
  code: Element;
}

export function createVisInjector(options: VisInjectorOptions): VisInjector {
  const {
    enabled,
    document: doc,
    imageResolver,
    theme = 'light',
    debounceMs = 250,
    showPendingSkeleton = true,
    onOutcome,
  } = options;

  const mounted = new Map<Element, Mounted>();
  const pending = new Map<Element, Pending>();
  const watchedTurns = new Set<Element>();
  let shallowObserver: MutationObserver | null = null;
  let deepObserver: MutationObserver | null = null;
  let timer: number | null = null;
  let started = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    const clear = (globalThis as { clearTimeout?: (id: number) => void }).clearTimeout;
    clear?.(timer);
    timer = null;
  };

  if (!enabled) {
    return {
      start() {},
      stop() {},
      scan() { return 0; },
      mountedCount() { return 0; },
      pendingCount() { return 0; },
      dispose() { mounted.clear(); pending.clear(); },
    };
  }

  function roots(): ParentNode[] {
    return options.roots ?? (doc.body ? [doc.body] : []);
  }

  function codeMatches(code: Element): boolean {
    const cls = code.getAttribute('class') ?? '';
    if (cls.includes(VIS_LANGUAGE_CLASS)) return true;
    return SNIFF.test(code.textContent ?? '');
  }

  function inAssistantTurn(code: Element): boolean {
    return code.closest(ASSISTANT_ROOT_SELECTOR) !== null;
  }

  function buildCardHost(html: string): HTMLElement {
    const host = doc.createElement('div');
    host.className = HOST_CLASS;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = buildVisCss({ scope: ':host' });
    shadow.appendChild(style);
    if (theme === 'dark') host.setAttribute('data-dppvis-theme', 'dark');
    const layer = doc.createElement('div');
    layer.innerHTML = html;
    while (layer.firstChild) shadow.appendChild(layer.firstChild);
    return host;
  }

  /** 骨架卡：与真卡同尺寸感（左图右文），只是内容是占位条。 */
  function buildPendingHost(): HTMLElement {
    const host = doc.createElement('div');
    host.className = `${HOST_CLASS} ${PENDING_CLASS}`;
    host.setAttribute('role', 'status');
    // 英文标签是临时措施：正式版应走 i18n（新增 vis.card.generating 的 en/zh-CN 键对）\n    host.setAttribute('aria-label', 'Generating card');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = buildVisCss({ scope: ':host' });
    shadow.appendChild(style);
    if (theme === 'dark') host.setAttribute('data-dppvis-theme', 'dark');
    const box = doc.createElement('div');
    box.className = 'dppvis-skeleton';
    box.innerHTML =
      '<div class="dppvis-skeleton__poster"></div>' +
      '<div class="dppvis-skeleton__col">' +
      '<div class="dppvis-skeleton__bar dppvis-skeleton__bar--title"></div>' +
      '<div class="dppvis-skeleton__bar dppvis-skeleton__bar--line"></div>' +
      '<div class="dppvis-skeleton__bar dppvis-skeleton__bar--short"></div>' +
      '</div>';
    shadow.appendChild(box);
    return host;
  }

  /** 还原原始代码块（失败路径）：删骨架 + 把 <pre> 显示回来。 */
  function restoreOriginal(code: Element, pre: Element, host: HTMLElement): void {
    host.remove();
    (pre as HTMLElement).style.display = '';
    pending.delete(code);
    code.setAttribute(STATE_ATTR, 'failed-restored');
  }

  function unmountStale(): void {
    for (const [code, entry] of mounted) {
      if (entry.host.isConnected) continue;
      entry.host.remove();
      mounted.delete(code);
    }
    for (const [code, entry] of pending) {
      if (entry.host.isConnected) continue;
      entry.host.remove();
      pending.delete(code);
    }
  }

  /**
   * 流式中：未闭合就先摆骨架。
   *
   * **关键**：这里是「隐藏 <pre> + 骨架插在其后」，而不是把 <pre> 换掉。
   * 换掉会把正在流式更新的 <code> 从 DOM 里摘下来 ⇒ 之后的文本更新再也观察不到，
   * 骨架会永远停在那里（这一点是被测试逼出来的，不是设想）。
   */
  function markPending(code: Element, pre: Element): void {
    code.setAttribute(STATE_ATTR, 'pending');
    if (!showPendingSkeleton) return;
    const existing = pending.get(code);
    if (existing && existing.host.isConnected) return;
    const host = buildPendingHost();
    (pre as HTMLElement).style.display = 'none';
    pre.after(host);
    pending.set(code, { host, pre, code });
  }

  /** 已闭合：把 pending 推进成真卡，或失败时还原。返回是否新渲染出卡。 */
  function resolvePending(code: Element, entry: Pending, raw: string): boolean {
    const parent = entry.host.parentElement;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      restoreOriginal(code, entry.pre, entry.host);
      code.setAttribute(STATE_ATTR, 'invalid-json');
      return false;
    }
    const { html, outcome } = renderToHtml(parsed, { imageResolver });
    onOutcome?.(outcome, code);
    if (outcome.status === 'failed' || html === '') {
      restoreOriginal(code, entry.pre, entry.host);
      code.setAttribute(STATE_ATTR, `failed:${outcome.reasons.join(',')}`);
      return false;
    }
    const card = buildCardHost(html);
    if (parent) entry.host.replaceWith(card);
    else entry.pre.after(card);
    entry.pre.remove();
    pending.delete(code);
    code.setAttribute(STATE_ATTR, 'rendered');
    mounted.set(code, { host: card, code, source: raw });
    return true;
  }

  function handle(code: Element): boolean {
    const existing = mounted.get(code);
    const raw = (code.textContent ?? '').trim();
    if (existing) {
      if (existing.source === raw && existing.host.isConnected) return false;
      existing.host.remove();
      mounted.delete(code);
      code.removeAttribute(STATE_ATTR);
    }
    if (!inAssistantTurn(code)) return false;

    const pre = code.closest('pre');
    if (!pre || !pre.parentElement) {
      // 已在 pending 且 <pre> 已脱离文档：只推进状态
      const held = pending.get(code);
      if (held) return raw.endsWith('}') ? resolvePending(code, held, raw) : false;
      return false;
    }

    if (!raw.endsWith('}')) {
      markPending(code, pre);
      return false;
    }
    const held = pending.get(code);
    if (held) return resolvePending(code, held, raw);
    if (!codeMatches(code)) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      code.setAttribute(STATE_ATTR, 'invalid-json');
      return false;
    }

    const { html, outcome } = renderToHtml(parsed, { imageResolver });
    onOutcome?.(outcome, code);
    if (outcome.status === 'failed' || html === '') {
      code.setAttribute(STATE_ATTR, `failed:${outcome.reasons.join(',')}`);
      return false;
    }

    const host = buildCardHost(html);
    pre.replaceWith(host);
    code.setAttribute(STATE_ATTR, 'rendered');
    mounted.set(code, { host, code, source: raw });
    return true;
  }

  function scan(): number {
    unmountStale();
    let rendered = 0;

    // code 始终留在 DOM（只是 <pre> 被隐藏），所以统一走下面这段 DOM 巡查即可
    for (const root of roots()) {
      const codes = root.querySelectorAll(CODE_SELECTOR);
      for (const code of Array.from(codes)) {
        try {
          if (handle(code)) rendered += 1;
        } catch {
          code.setAttribute(STATE_ATTR, 'error');
        }
      }
    }
    return rendered;
  }

  function watchTurn(turn: Element): void {
    if (!deepObserver || watchedTurns.has(turn)) return;
    watchedTurns.add(turn);
    deepObserver.observe(turn, { childList: true, subtree: true, characterData: true });
  }

  function watchAllTurns(): void {
    for (const root of roots()) {
      const query = (root as ParentNode).querySelectorAll;
      if (typeof query !== 'function') continue;
      for (const turn of Array.from((root as ParentNode).querySelectorAll(ASSISTANT_ROOT_SELECTOR))) {
        watchTurn(turn);
      }
    }
  }

  function isRelevant(record: MutationRecord): boolean {
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (el.matches?.(ASSISTANT_ROOT_SELECTOR)) return true;
      if (el.querySelector?.(ASSISTANT_ROOT_SELECTOR)) return true;
    }
    for (const node of Array.from(record.removedNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (el.classList?.contains(HOST_CLASS)) return true;
      if (el.querySelector?.(`.${HOST_CLASS}`)) return true;
    }
    return false;
  }

  function schedule(): void {
    clearTimer();
    const set = (globalThis as { setTimeout?: (fn: () => void, ms: number) => number }).setTimeout;
    if (!set) return;
    timer = set(() => {
      timer = null;
      scan();
      watchAllTurns();
    }, debounceMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
      if (MO) {
        deepObserver = new MO(() => schedule());
        shallowObserver = new MO((records) => {
          if (records.some(isRelevant)) schedule();
        });
        for (const root of roots()) {
          shallowObserver.observe(root as Node, { childList: true, subtree: true });
        }
      }
      scan();
      watchAllTurns();
    },
    stop() {
      started = false;
      shallowObserver?.disconnect();
      deepObserver?.disconnect();
      shallowObserver = null;
      deepObserver = null;
      watchedTurns.clear();
      clearTimer();
    },
    scan,
    mountedCount() { return mounted.size; },
    pendingCount() { return pending.size; },
    dispose() {
      this.stop();
      for (const entry of mounted.values()) entry.host.remove();
      for (const entry of pending.values()) entry.host.remove();
      mounted.clear();
      pending.clear();
    },
  };
}
