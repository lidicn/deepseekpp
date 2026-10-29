import { renderVisChildren, type VisComponentRenderer } from '../registry';
import { MAX_CHILDREN_PER_NODE } from '../types';

/**
 * 横向容器：PoC 的「左图右文」就是这个。
 *
 * 为什么单独一个组件而不是给 Column 加 direction 参数：
 * 版式差异（子项收缩策略、图片固定宽度）是**结构性**的，塞进同一个组件会让 props 分叉；
 * 而加组件在本仓是零成本（S2 已验证：新增文件 + 一行注册，不碰 registry/render/catalog）。
 */
export const rowRenderer: VisComponentRenderer = {
  type: 'Row',
  allowsChildren: true,
  maxChildren: MAX_CHILDREN_PER_NODE,
  render(props, ctx) {
    return `<div class="dppvis-row">${renderVisChildren(props.children, ctx)}</div>`;
  },
};
