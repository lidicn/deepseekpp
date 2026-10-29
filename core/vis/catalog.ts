/**
 * 组件目录：集中声明「有哪些组件、能不能有子节点、上限多少」。
 *
 * 加组件时：在 components/ 下新增实现 + 在 registry 里注册；catalog 只描述约束。
 * 未在 catalog 注册的 type 一律降级为 Text（不报错、不渲染未知结构）。
 */
import type { VisComponentType } from './types';
import { MAX_CHILDREN_PER_NODE } from './types';

export interface ComponentSpec {
  type: VisComponentType;
  allowsChildren: boolean;
  maxChildren: number;
}

export const COMPONENT_SPECS: Record<VisComponentType, ComponentSpec> = {
  Column: { type: 'Column', allowsChildren: true, maxChildren: MAX_CHILDREN_PER_NODE },
  Image: { type: 'Image', allowsChildren: false, maxChildren: 0 },
  Text: { type: 'Text', allowsChildren: false, maxChildren: 0 },
};

export const FALLBACK_COMPONENT_TYPE: VisComponentType = 'Text';

export function isKnownComponentType(value: unknown): value is VisComponentType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMPONENT_SPECS, value);
}
