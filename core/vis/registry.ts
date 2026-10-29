/**
 * 组件注册表：与仓内 registerToolResultRenderer 同范式（注册 + 逐个 try/catch）。
 *
 * 扩展性契约：**加组件 = 新增 components/*.ts + 一行 registerVisComponent(...)**，
 * 不修改本文件、不修改 render.ts、不修改 catalog.ts。
 */
import { getComponentSpec, registerComponentSpec } from './catalog';
import { escapeHtml, isRecord } from './escape';
import type { ImageResolver } from './image-resolver';
import { MAX_DEPTH, MAX_NODES_TOTAL, type RenderOutcome, noteOutcome } from './types';

export interface VisRenderContext {
  depth: number;
  outcome: RenderOutcome;
  imageResolver: ImageResolver;
  /** 已渲染节点计数（用于 MAX_NODES_TOTAL 上限）。 */
  counter: { nodes: number };
  /**
   * 转义入口。**注册的组件必须用它处理一切可变文本/属性值**，
   * 而不是自己拼字符串 —— 这样"转义"从口头约定变成可注入、可断言的契约
   * （测试可注入计数版 escape 断言"每个可变值都被转义过"）。
   */
  escape: (value: unknown) => string;
}

export interface VisComponentRenderer {
  /** 组件类型名。 */
  type: string;
  /** 是否允许 children（缺省 false）。 */
  allowsChildren?: boolean;
  /** 子节点上限（缺省 MAX_CHILDREN_PER_NODE）。 */
  maxChildren?: number;
  /** 返回 HTML 片段；内部所有文本/属性必须走 escape.ts。 */
  render(props: Record<string, unknown>, ctx: VisRenderContext): string;
}

const renderers = new Map<string, VisComponentRenderer>();

export function registerVisComponent(renderer: VisComponentRenderer): void {
  renderers.set(renderer.type, renderer);
  registerComponentSpec({
    type: renderer.type,
    allowsChildren: renderer.allowsChildren === true,
    maxChildren: renderer.maxChildren ?? 0,
  });
}

export function unregisterVisComponent(type: string): void {
  renderers.delete(type);
}

export function getRegisteredTypes(): string[] {
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

  if (!isRegisteredType(rawType)) {
    // 未知 type：与旧实现一致 —— 退化为「可读标题 + meta」，并丢弃其子树。
    noteOutcome(ctx.outcome, 'degraded', `unknown_type:${rawType || 'missing'}`);
    return renderTextFallback(node, ctx);
  }
  const type = rawType;

  const renderer = renderers.get(type);
  if (!renderer) {
    noteOutcome(ctx.outcome, 'degraded', `unregistered_component:${type}`);
    return renderTextFallback(node, ctx);
  }

  const spec = getComponentSpec(type);
  let props: Record<string, unknown> = record ?? {};
  if (!spec || !spec.allowsChildren) {
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

function isRegisteredType(type: string): boolean {
  return renderers.has(type);
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

/** 仅供测试：清空注册表（含 spec）。 */
export function resetVisRegistryForTests(): void {
  renderers.clear();
}
