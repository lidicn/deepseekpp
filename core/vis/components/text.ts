import { escapeHtml, toText, truncateText } from '../escape';
import type { VisComponentRenderer } from '../registry';

function variantClass(variant: unknown): string {
  switch (variant) {
    case 'title': return 'dppvis-text--title';
    case 'subtitle': return 'dppvis-text--subtitle';
    case 'meta': return 'dppvis-text--meta';
    default: return 'dppvis-text--body';
  }
}

export const textRenderer: VisComponentRenderer = {
  type: 'Text',
  render(props) {
    const body = escapeHtml(truncateText(toText(props.text)));
    return `<div class="dppvis-text ${variantClass(props.variant)}">${body}</div>`;
  },
};
