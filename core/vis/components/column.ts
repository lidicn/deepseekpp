import { renderVisChildren, type VisComponentRenderer } from '../registry';

export const columnRenderer: VisComponentRenderer = {
  type: 'Column',
  render(props, ctx) {
    return `<div class="dppvis-column">${renderVisChildren(props.children, ctx)}</div>`;
  },
};
