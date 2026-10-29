/**
 * 组件注册表：与仓内 registerToolResultRenderer 同范式（数组 + 逐个 try/catch）。
 *
 * 扩展性契约：新增组件只注册，不改本文件；renderVisNode 通过 catalog 判断结构与上限。
 */
import { COMPONENT_SPECS, isKnownComponentType } from './catalog';
import { escapeHtml, isRecord, toText } from './escape';
import type { ImageResolver } from './image-resolver';
import { MAX_DEPTH, MAX_NODES_TOTAL, type RenderOutcome, noteOutcome, type VisComponentType } from './types';

export interface VisRenderContext {
  depth: number;
  outcome: RenderOutcome;
  imageResolver: ImageResolver;
  /** 已渲染节点计数（用于 MAX_NODES_TOTAL 上限）。 */
  counter: { nodes: number };
}

export interface VisComponentRenderer {
  type: VisComponentType;
  /** 返回 HTML 片段；内部所有文本/属性必须走 escape.ts。 */
  render(props: Record<string, unknown>, ctx: VisRenderContext): string;
}

const renderers = new Map<VisComponentType, VisComponentRenderer>();

export function registerVisComponent(renderer: VisComponentRenderer): void {
  renderers.set(renderer.type, renderer);
}

export function getRegisteredTypes(): VisComponentType[] {
  return [...renderers.keys()];
}

/** 未知节点降级用的可读标题：依次取 title/text/alt/label/name。 */
export function readableTitle(node: unknown): string {
  if (typeof node === 'string' && node.trim() !== '') return node;
  if (!isRecord(node)) return '[unsupported node]';
  for (const key of ['title', 'text', 'alt', 'label', 'name']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  const type = node.type;
  if (typeof type === 'string' && type.trim() !== '') return `[unsupported: ${type.trim()}]`;
  return '[unsupported node]';
}

/** 渲染单个节点（容错：任何异常都降级为该子树的文本占位，不影响兄弟节点）。 */
export function renderVisNode(node: unknown, ctx: VisRenderContext): string {
  if (ctx.depth > MAX_DEPTH) {
    noteOutcome(ctx.outcome, 'degraded', 'max_depth');
    return '';
  }
  if (node === null || node === undefined) return '';
  if (ctx.counter.nodes >= MAX_NODES_TOTAL) {
    noteOutcome(ctx.outcome, 'degraded', 'max_nodes');
    return '';
  }
  ctx.counter.nodes += 1;

  const record = isRecord(node) ? node : null;
  const rawType = record !== null && typeof record.type === 'string' ? record.type : '';
  if (!isKnownComponentType(rawType)) {
    // 未知 type：与旧实现一致 —— 退化为「可读标题 + meta」，并丢弃其子树。
    noteOutcome(ctx.outcome, 'degraded', `unknown_type:${rawType || 'missing'}`);
    return renderTextFallback(node, ctx);
  }
  const type: VisComponentType = rawType;

  const renderer = renderers.get(type);
  if (!renderer) {
    noteOutcome(ctx.outcome, 'degraded', `unregistered_component:${type}`);
    return renderTextFallback(node, ctx);
  }

  const spec = COMPONENT_SPECS[type];
  let props: Record<string, unknown> = record ?? {};
  if (!spec.allowsChildren) {
    const { children: _ignored, ...rest } = props;
    props = rest;
  } else if (Array.isArray(props.children) && props.children.length > spec.maxChildren) {
    noteOutcome(ctx.outcome, 'degraded', 'max_children');
    props = { ...props, children: props.children.slice(0, spec.maxChildren) };
  }

  try {
    return renderer.render(props, ctx);
  } catch (error) {
    // 单组件失败不能击穿整张卡：记降级原因，该子树退化为文本占位。
    noteOutcome(ctx.outcome, 'degraded', `component_threw:${type}`);
    void error;
    return renderTextFallback(node, ctx);
  }
}

/** 渲染 children（供容器组件复用）。 */
export function renderVisChildren(rawChildren: unknown, ctx: VisRenderContext): string {
  const children = Array.isArray(rawChildren) ? rawChildren : [];
  const next: VisRenderContext = { ...ctx, depth: ctx.depth + 1 };
  return children.map((child) => renderVisNode(child, next)).join('');
}

function renderTextFallback(node: unknown, ctx: VisRenderContext): string {
  const textRenderer = renderers.get('Text');
  if (!textRenderer) return escapeHtml(readableTitle(node));
  try {
    return textRenderer.render({ text: readableTitle(node), variant: 'meta' }, ctx);
  } catch {
    return escapeHtml(readableTitle(node));
  }
}

export function resetVisRegistryForTests(): void {
  renderers.clear();
}

export function unregisterVisComponent(type: VisComponentType): void {
  renderers.delete(type);
}

void toText;
