/**
 * 不依赖代码围栏的文档识别。
 *
 * 为什么需要：实测发现模型经常**不打 **```** 围栏**，而是把 `vis-json` 写成普通文字、
 * JSON 当正文段落输出（真机诊断：scanned=0 但 turns=5）。只认 `pre > code` 就永远不出卡。
 * 所以这里改为在**回合正文**里找 `{"v":1` 的起点，做括号配平，再 JSON.parse 校验。
 */

export interface TextRange {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

export interface DetectedDocument {
  doc: unknown;
  raw: string;
  range: TextRange;
}

const SNIFF = /\{\s*"v"\s*:\s*1\b/;

/** 从 openIndex（指向 '}' 前的 '{'）开始做括号配平，返回闭合位置（含）或 -1。 */
export function matchJsonEnd(text: string, openIndex: number): number {
  if (text[openIndex] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectTextNodes(root: ParentNode): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument === null ? null : (root as Element).ownerDocument?.createTreeWalker(root as Node, 4 /* NodeFilter.SHOW_TEXT */);
  if (!walker) return out;
  let node = walker.nextNode();
  while (node) {
    if ((node as Text).data.trim() !== '') out.push(node as Text);
    node = walker.nextNode();
  }
  return out;
}

/**
 * 在 root 里找所有可解析的 A2UI 子集文档（最多 limit 个）。
 * 只返回能 JSON.parse 成功的，避免把半截或不相干的 JSON 当成卡片。
 */
export function findVisDocuments(root: ParentNode, limit = 3): DetectedDocument[] {
  const nodes = collectTextNodes(root);
  if (nodes.length === 0) return [];

  // 把文本节点拼成一条长串，并记录每个节点在长串里的起止位置
  const spans: Array<{ node: Text; start: number; end: number }> = [];
  let joined = '';
  for (const node of nodes) {
    const start = joined.length;
    joined += node.data;
    spans.push({ node, start, end: joined.length });
  }

  const found: DetectedDocument[] = [];
  let searchFrom = 0;
  while (found.length < limit) {
    const slice = joined.slice(searchFrom);
    const hit = SNIFF.exec(slice);
    if (!hit) break;
    const start = searchFrom + (hit.index ?? 0);
    const openIndex = start + (hit[0].indexOf('{'));
    const end = matchJsonEnd(joined, openIndex);
    if (end < 0) break;
    const raw = joined.slice(openIndex, end + 1);
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      searchFrom = end + 1;
      continue;
    }
    const startSpan = spans.find((span) => openIndex >= span.start && openIndex < span.end);
    const endSpan = spans.find((span) => end >= span.start && end < span.end);
    if (!startSpan || !endSpan) { searchFrom = end + 1; continue; }
    found.push({
      doc,
      raw,
      range: {
        startNode: startSpan.node,
        startOffset: openIndex - startSpan.start,
        endNode: endSpan.node,
        endOffset: end - endSpan.start + 1,
      },
    });
    searchFrom = end + 1;
  }
  return found;
}

/** 找到覆盖该文本范围的最外层块级元素（用于整体替换成卡片）。 */
export function blockElementsFor(range: TextRange, stopAt: Element): Element[] {
  const blocks: Element[] = [];
  let node: Node | null = range.startNode;
  while (node && node !== stopAt.parentNode) {
    if (node.nodeType === 1 && node !== stopAt) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'p' || tag === 'li' || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'blockquote') {
        blocks.push(el);
      }
    }
    node = node.parentNode;
  }
  // 从内到外收集，最后取最外层
  if (blocks.length > 0) return [blocks[blocks.length - 1]];
  // 退化：用文本节点的父元素
  const parent = range.startNode.parentElement;
  return parent ? [parent] : [];
}
