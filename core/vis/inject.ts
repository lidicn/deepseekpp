/**
 * S7 注入层：把模型输出里的 `vis-json` 代码块渲染成卡片。
 *
 * 设计约束（每条都对应一个已知失败模式）：
 * 1. **只碰助手回合**：锚在 DeepSeek 的语义类 `.ds-markdown` 内，不劫持用户消息里的 JSON。
 * 2. **判据双通道**：`language-vis-json` 类名**或**内容嗅探（`{"v":1`），避免站点改 fence 实现就整体失效。
 * 3. **未闭合不处理**：流式内容以 `}` 结尾才算完整；否则保持原样（不裸奔、不误判）。
 * 4. **失败一律保留原文**：`RenderOutcome.status === 'failed'` ⇒ 不动 DOM（绝不空白卡片）。
 * 5. **样式隔离**：卡片放进 Shadow DOM，CSS 由 `buildVisCss({ scope: ':host' })` 生成，不污染宿主页面。
 * 6. **幂等 + 可回收**：同一节点重复扫描只渲染一次；节点被框架移除后清理内部状态。
 * 7. **默认关闭**：由调用方传 `enabled`，关闭时 `start()` 不挂任何监听。
 * 8. **监听面收窄**（QA-15 建议）：body 上只监听 `childList`（**不**监听 `characterData`），
 *    仅用于发现**新的**助手回合；真正的内容更新只对已发现的 `.ds-markdown` 根做深度监听。
 *    这样流式期不会因为整页任意文本变化而反复扫描。真正拦住误触发的是 `isRelevant` 谓词
 *    （只放行"新增节点含 .ds-markdown"与"卡片被移除"）；observer 选项收窄的收益是
 *    "少把 mutation 记录递进 JS"，属成本优化，单测不可观测。
 */

import type { ImageResolver } from './image-resolver';
import { renderToHtml } from './render';
import { buildVisCss } from './theme';
import type { RenderOutcome } from './types';

const VIS_LANGUAGE_CLASS = 'vis-json';
const ASSISTANT_ROOT_SELECTOR = '.ds-markdown';
const CODE_SELECTOR = 'pre > code';
const HOST_CLASS = 'dppvis-host';
const STATE_ATTR = 'data-dppvis-state';
const SNIFF = /^\s*\{\s*"v"\s*:\s*1\b/;

export interface VisInjectorOptions {
  /** 必须显式开启；关闭时 start() 是空操作。 */
  enabled: boolean;
  /** 注入用的 Document（测试可传 jsdom 的 document）。 */
  document: Document;
  imageResolver?: ImageResolver;
  theme?: 'light' | 'dark';
  /** 扫描去抖窗口，默认 250ms（QA-15 建议 200–300ms）。 */
  debounceMs?: number;
  /** 只在这些容器内找（默认 document.body）。 */
  roots?: ParentNode[];
  /** 每次处理的结果回调（便于埋点/诊断）。 */
  onOutcome?: (outcome: RenderOutcome, code: Element) => void;
}

export interface VisInjector {
  start(): void;
  stop(): void;
  /** 立即扫描一次，返回本次新渲染的卡片数（测试与手动触发用）。 */
  scan(): number;
  /** 当前已挂载的卡片数。 */
  mountedCount(): number;
  dispose(): void;
}

interface Mounted {
  host: HTMLElement;
  code: Element;
  source: string;
}

export function createVisInjector(options: VisInjectorOptions): VisInjector {
  const {
    enabled,
    document: doc,
    imageResolver,
    theme = 'light',
    debounceMs = 250,
    onOutcome,
  } = options;

  const mounted = new Map<Element, Mounted>();
  /** 已挂深度监听的助手回合根（避免重复 observe）。 */
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
      dispose() { mounted.clear(); },
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

  function buildHost(html: string): HTMLElement {
    const host = doc.createElement('div');
    host.className = HOST_CLASS;
    // 用 open 而非 closed：页面脚本本就能看到这段内容，open 便于排障与测试。
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = buildVisCss({ scope: ':host' });
    shadow.appendChild(style);
    if (theme === 'dark') host.setAttribute('data-dppvis-theme', 'dark');
    const layer = doc.createElement('div');
    // 输入只来自 renderToHtml 的输出（常量模板 + escapeHtml 结果），见 S4 不变量测试
    layer.innerHTML = html;
    while (layer.firstChild) shadow.appendChild(layer.firstChild);
    return host;
  }

  function unmountStale(): void {
    for (const [code, entry] of mounted) {
      // 注意：渲染后 code 已随 <pre> 被替换而脱离文档，**不能**拿 code.isConnected 判陈旧，
      // 否则刚挂上的卡片会被自己清掉。只认 host 是否还在 DOM 里。
      if (entry.host.isConnected) continue;
      entry.host.remove();
      mounted.delete(code);
    }
  }

  function handle(code: Element): boolean {
    const existing = mounted.get(code);
    const raw = (code.textContent ?? '').trim();
    if (existing) {
      // 同一节点内容变了（如重新生成）⇒ 重建；内容没变 ⇒ 幂等跳过
      if (existing.source === raw && existing.host.isConnected) return false;
      existing.host.remove();
      mounted.delete(code);
      code.removeAttribute(STATE_ATTR);
    }
    if (!inAssistantTurn(code)) return false;
    // 流式未闭合：等下一次扫描，不动 DOM
    if (!raw.endsWith('}')) {
      code.setAttribute(STATE_ATTR, 'pending');
      return false;
    }
    if (!codeMatches(code)) return false;

    const pre = code.closest('pre');
    if (!pre || !pre.parentElement) return false;

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
      // 结构性失败：保留原代码块，用户仍能读到内容
      code.setAttribute(STATE_ATTR, `failed:${outcome.reasons.join(',')}`);
      return false;
    }

    const host = buildHost(html);
    pre.replaceWith(host);
    code.setAttribute(STATE_ATTR, 'rendered');
    mounted.set(code, { host, code, source: raw });
    return true;
  }

  function scan(): number {
    unmountStale();
    let rendered = 0;
    for (const root of roots()) {
      const codes = root.querySelectorAll(CODE_SELECTOR);
      for (const code of Array.from(codes)) {
        try {
          if (handle(code)) rendered += 1;
        } catch {
          // 单块失败不影响其它块
          code.setAttribute(STATE_ATTR, 'error');
        }
      }
    }
    return rendered;
  }

  /** 对已发现的助手回合做深度监听（含 characterData：流式文本更新走这里）。 */
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

  /** 浅监听只关心「新增节点里是否出现助手回合」或「卡片被移除」。 */
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
      // 新出现的回合要补挂深度监听
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
        // 第 1 层：只在 body 上盯 childList（不盯 characterData），用于发现新的助手回合
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
    dispose() {
      this.stop();
      for (const entry of mounted.values()) entry.host.remove();
      mounted.clear();
    },
  };
}
