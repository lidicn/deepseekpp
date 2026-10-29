/**
 * A2UI 子集的数据契约（PoC 阶段）。
 *
 * 为什么是 A2UI 子集而不是自造格式：A2UI（Apache 2.0）的 adjacency list 模型
 * 与旧 vis-json v1 形态一致，且已解决 props 白名单（catalog）、结构/数据分离、
 * 版本演进与渐进渲染。这里只实现 PoC 需要的三种节点。
 */

export type TextVariant = 'title' | 'subtitle' | 'body' | 'meta';
export type ImageRatio = '2/3' | '16/9';

export interface A2UITextNode {
  type: 'Text';
  text: string;
  variant?: TextVariant;
}

export interface A2UIImageNode {
  type: 'Image';
  src: string | null;
  alt: string;
  ratio?: ImageRatio;
  fallback?: { hue?: number };
}

export interface A2UIColumnNode {
  type: 'Column';
  children: A2UINode[];
}

export type A2UINode = A2UITextNode | A2UIImageNode | A2UIColumnNode;

export const A2UI_VERSION = 1;

export interface A2UIDocument {
  v: typeof A2UI_VERSION;
  root: A2UINode;
}

/** 核心组件类型（供文档/测试引用；注册表本身接受任意 string）。 */
export type CoreVisComponentType = 'Column' | 'Image' | 'Text';

// ---------------- limits（集中一处，便于 catalog 与渲染器共用） ----------------
export const MAX_DEPTH = 8;
export const MAX_TEXT_LENGTH = 400;
export const DEFAULT_HUE = 210;
export const MAX_CHILDREN_PER_NODE = 24;
export const MAX_NODES_TOTAL = 120;

// ---------------- 渲染结果（分三级，供注入层决定是否兜底显示原文） ----------------
export type RenderStatus = 'ok' | 'degraded' | 'failed';

export interface RenderOutcome {
  status: RenderStatus;
  reasons: string[];
}

export function createOutcome(): RenderOutcome {
  return { status: 'ok', reasons: [] };
}

/**
 * 记录一次降级/失败。failed 级别一旦出现就锁定，避免后续 ok 把它冲掉。
 */
export function noteOutcome(
  outcome: RenderOutcome,
  level: Exclude<RenderStatus, 'ok'>,
  reason: string,
): void {
  if (!outcome.reasons.includes(reason)) outcome.reasons.push(reason);
  if (level === 'failed') outcome.status = 'failed';
  else if (outcome.status === 'ok') outcome.status = 'degraded';
}
