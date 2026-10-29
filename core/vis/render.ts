/**
 * 渲染入口：A2UI 子集 → HTML 字符串 / DocumentFragment。
 *
 * 版本协商：v 不匹配 ⇒ failed（上层保留原始代码块），绝不"尽力渲染"错版。
 */
import { registerCoreVisComponents } from './components';
import { escapeHtml, isRecord } from './escape';
import { passthroughImageResolver, type ImageResolver } from './image-resolver';
import { readableTitle, renderVisNode, type VisRenderContext } from './registry';
import {
  A2UI_VERSION,
  createOutcome,
  type RenderOutcome,
  noteOutcome,
} from './types';

let coreRegistered = false;

function ensureCoreComponents(): void {
  if (coreRegistered) return;
  registerCoreVisComponents();
  coreRegistered = true;
}

export interface VisRenderOptions {
  imageResolver?: ImageResolver;
  /** 仅供测试：跳过版本校验（模拟旧 renderPocHtml 行为）。 */
  skipVersionCheck?: boolean;
}

export interface VisRenderResult {
  html: string;
  outcome: RenderOutcome;
}

function buildContext(options: VisRenderOptions, outcome: RenderOutcome): VisRenderContext {
  return {
    depth: 1,
    outcome,
    imageResolver: options.imageResolver ?? passthroughImageResolver,
    counter: { nodes: 0 },
    escape: escapeHtml,
  };
}

/**
 * 渲染为 HTML 字符串。
 * failed 时返回空字符串（不是"半张卡"），由调用方决定回退展示原文。
 */
export function renderToHtml(doc: unknown, options: VisRenderOptions = {}): VisRenderResult {
  ensureCoreComponents();
  const outcome = createOutcome();

  if (!options.skipVersionCheck) {
    const version = isRecord(doc) ? doc.v : undefined;
    if (version !== A2UI_VERSION) {
      noteOutcome(outcome, 'failed', `unsupported_version:${String(version)}`);
      return { html: '', outcome };
    }
  }

  const root = isRecord(doc) ? doc.root : undefined;
  const body = renderVisNode(root, buildContext(options, outcome));
  if (body === '' && outcome.status === 'ok') {
    noteOutcome(outcome, 'failed', 'empty_document');
    return { html: '', outcome };
  }
  if (outcome.status === 'failed') return { html: '', outcome };
  return { html: `<div class="dppvis-root">${body}</div>`, outcome };
}

/**
 * 渲染为 DocumentFragment。
 *
 * 实现走「单一真源」：先 `renderToHtml`，再把结果放进一个**游离 div**、搬进 fragment。
 * 也就是说这里**确实用了一次 innerHTML** —— 但输入不含任何未经 escapeHtml 的模型数据
 * （不变量由 `tests/vis-render-contract.test.ts` 的 XSS 用例与 `vis-hardening` 的敌对 props 矩阵守护）。
 * 不做"DOM 直构"是刻意的：那要把每个组件写两遍，两条出口必然漂移（评审 I3 类缺陷）。
 */
export function renderToFragment(
  doc: unknown,
  docNode: Document,
  options: VisRenderOptions = {},
): { fragment: DocumentFragment; outcome: RenderOutcome } {
  const { html, outcome } = renderToHtml(doc, options);
  const fragment = docNode.createDocumentFragment();
  const host = docNode.createElement('div');
  if (html === '') {
    return { fragment, outcome };
  }
  host.innerHTML = html;
  while (host.firstChild) fragment.appendChild(host.firstChild);
  return { fragment, outcome };
}

/** 兼容旧 API：不做版本校验（旧 renderPocHtml 语义），deprecated。 */
export function renderLegacy(input: unknown, options: VisRenderOptions = {}): string {
  return renderToHtml(input, { ...options, skipVersionCheck: true }).html
    || `<div class="dppvis-root">${''}</div>`.replace('<div class="dppvis-root"></div>', renderLegacyRoot(input, options));
}

function renderLegacyRoot(input: unknown, options: VisRenderOptions): string {
  ensureCoreComponents();
  const outcome = createOutcome();
  const root = isRecord(input) ? input.root : undefined;
  const body = renderVisNode(root, buildContext(options, outcome));
  return `<div class="dppvis-root">${body}</div>`;
}

export { escapeHtml, readableTitle };
