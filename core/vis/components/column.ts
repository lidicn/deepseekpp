import { renderVisChildren, type VisComponentRenderer } from '../registry';
import { MAX_CHILDREN_PER_NODE } from '../types';

export const columnRenderer: VisComponentRenderer = {
  type: 'Column',
  allowsChildren: true,
  maxChildren: MAX_CHILDREN_PER_NODE,
  render(props, ctx) {
    return `<div class="dppvis-column">${renderVisChildren(props.children, ctx)}</div>`;
  },
};
