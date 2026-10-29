/**
 * vis 模块唯一对外入口。注入层 / 导出 / 其它消费者只 import 这里。
 */
export type {
  A2UIColumnNode,
  A2UIDocument,
  A2UIImageNode,
  A2UINode,
  A2UITextNode,
  CoreVisComponentType,
  ImageRatio,
  RenderOutcome,
  RenderStatus,
  TextVariant,
} from './types';
export {
  A2UI_VERSION,
  DEFAULT_HUE,
  MAX_CHILDREN_PER_NODE,
  MAX_DEPTH,
  MAX_NODES_TOTAL,
  MAX_TEXT_LENGTH,
} from './types';
export { escapeHtml, toText, truncateText } from './escape';
export { isSafeImageSrc, passthroughImageResolver } from './image-resolver';
export type { ImageResolver, ResolvedImage } from './image-resolver';
export {
  getComponentSpec,
  isKnownComponentType,
  listComponentSpecs,
  registerComponentSpec,
} from './catalog';
export type { ComponentSpec } from './catalog';
export {
  getRegisteredTypes,
  registerVisComponent,
  renderVisChildren,
  renderVisNode,
  resetVisRegistryForTests,
  unregisterVisComponent,
} from './registry';
export type { VisComponentRenderer, VisRenderContext } from './registry';
export { registerCoreVisComponents } from './components';
export { renderToFragment, renderToHtml } from './render';
export type { VisRenderOptions, VisRenderResult } from './render';
