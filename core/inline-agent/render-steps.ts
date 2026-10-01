/**
 * render-steps.ts — Inline-agent 步骤流、推理笔记、工具条目渲染。
 * 职责：步骤元素、推理笔记、流式文本渲染、滚动跟随、工具条目管理。
 */
import { renderInlineMarkdown } from './markdown';
import { summarizeInlineAgentToolParams } from './display-text';
import type { InlineAgentRendererLabels } from './render-console';
import type { ToolExecutionRecord, ToolResult } from '../types';

let agentDomSequence = 0;

function nextAgentDomId(prefix: string): string {
  agentDomSequence += 1;
  return `${prefix}-${agentDomSequence}`;
}
// ---------------------------------------------------------------------------
interface AgentStreamState {
  currentToolGroup: HTMLElement | null;
  pendingRowsByStep: Map<number, HTMLElement[]>;
}
const agentStreamStates = new WeakMap<HTMLElement, AgentStreamState>();

function getAgentStreamState(stream: HTMLElement): AgentStreamState {
  let state = agentStreamStates.get(stream);
  if (!state) {
    state = { currentToolGroup: null, pendingRowsByStep: new Map() };
    agentStreamStates.set(stream, state);
  }
  return state;
}
export function adoptReasoningBlock(host: HTMLElement): boolean {
  if (host.classList.contains('dpp-agent-reasoning-adopted')) return false;
  host.classList.add('dpp-agent-reasoning-adopted');
  return true;
}

/**
 * Creates the narration segment for one step. The segment is NOT attached to
 * the stream yet: it is mounted (and the previous tool group sealed) on the
 * first non-empty text via {@link mountAgentNarration}, so textless tool-only
 * steps never leave an empty paragraph in the flow.
 */
export function createAgentStepElement(stepIndex: number): HTMLElement {
  const narration = document.createElement('div');
  narration.className = 'dpp-agent-step dpp-agent-narration';
  narration.setAttribute('data-step-index', String(stepIndex));
  narration.setAttribute('data-status', 'streaming');

  const body = document.createElement('div');
  body.className = 'dpp-agent-step-body';

  narration.appendChild(body);
  return narration;
}

/**
 * Places a narration segment into the stream at its chronological position
 * (after every segment of earlier steps, before any segment of the same or a
 * later step) and seals the current tool group: narration text separates tool
 * groups, so consecutive textless steps keep sharing one group while any
 * narration between tool batches starts a fresh one. A folded reasoning note
 * for the step ("Thought · step N") is mounted right before the narration.
 */
export function createAgentReasoningNoteElement(
  stepNumber: number,
  labels?: Partial<InlineAgentRendererLabels>,
  reasoningText?: string,
): HTMLElement {
  const note = document.createElement('div');
  note.className = 'dpp-agent-reasoning-note';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dpp-agent-reasoning-note-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('span');
  icon.className = 'dpp-agent-reasoning-note-icon';
  icon.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'dpp-agent-reasoning-note-title';
  title.textContent = labels?.reasoningStep?.(stepNumber) ?? `Thought · step ${stepNumber + 1}`;

  const chevron = document.createElement('span');
  chevron.className = 'dpp-agent-reasoning-note-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  toggle.appendChild(icon);
  toggle.appendChild(title);
  toggle.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'dpp-agent-reasoning-note-body';
  body.hidden = true;
  body.textContent = reasoningText ?? labels?.reasoningNotPersisted
    ?? 'The thinking process for this step is not retained in the message stream.';

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.hidden = expanded;
  });

  note.appendChild(toggle);
  note.appendChild(body);
  return note;
}

/**
 * Fills the step's folded reasoning note with the real captured thinking text
 * (replacing the "not retained" placeholder). Idempotent: the note is created
 * on demand and the body text is replaced in place, so repeated updates from
 * reasoning deltas are safe. The note stays collapsed; only the stored body
 * changes.
 */
export function updateAgentReasoningNoteElement(note: HTMLElement, reasoningText: string): void {
  if (!reasoningText) return;
  const body = note.querySelector<HTMLElement>('.dpp-agent-reasoning-note-body');
  if (!body) return;
  if (body.textContent === reasoningText) return;
  body.textContent = reasoningText;
  // The note was created with the placeholder; once real content exists the
  // collapsed toggle still opens the real text, so nothing else changes.
}

/**
 * Finds the folded reasoning note mounted right before a narration segment.
 */
export function getAgentReasoningNote(step: HTMLElement): HTMLElement | null {
  const previous = step.previousElementSibling;
  return previous?.classList.contains('dpp-agent-reasoning-note')
    ? (previous as HTMLElement)
    : null;
}

export function sealCurrentToolGroup(stream: HTMLElement): void {
  const state = getAgentStreamState(stream);
  const group = state.currentToolGroup;
  if (!group) return;
  state.currentToolGroup = null;
  // Sealed groups collapse to their one-line header; a manual toggle is never
  // overridden (Issue #544).
  if (group.getAttribute('data-user-toggled') !== 'true') {
    setAgentToolGroupCollapsed(group, true);
  }
}

function setAgentToolGroupCollapsed(group: HTMLElement, collapsed: boolean): void {
  group.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
  const toggle = group.querySelector<HTMLElement>('.dpp-agent-tool-group-toggle');
  toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/**
 * Collapses every tool group of a finished run (unless the user toggled it)
 * and forgets the open-group bookkeeping.
 */
export function collapseAllAgentToolGroups(stream: HTMLElement): void {
  for (const group of stream.querySelectorAll<HTMLElement>(':scope > .dpp-agent-tool-group')) {
    if (group.getAttribute('data-user-toggled') !== 'true') {
      setAgentToolGroupCollapsed(group, true);
    }
  }
  const state = agentStreamStates.get(stream);
  if (state) state.currentToolGroup = null;
}

export function updateStepStreamText(step: HTMLElement, visibleText: string): void {
  const body = step.querySelector<HTMLElement>('.dpp-agent-step-body');
  if (!body) return;
  if (!visibleText) {
    // Drop the folded reasoning note mounted right before this narration.
    const previous = step.previousElementSibling;
    if (previous?.classList.contains('dpp-agent-reasoning-note')) previous.remove();
    step.remove();
    return;
  }
  if (body.getAttribute('data-dpp-raw-text') === visibleText) {
    // Byte-identical text (the step render clamp makes every later frame
    // identical once the display cap is reached): skip the full markdown
    // re-parse and DOM rebuild. Rebuilding also destroyed in-flight
    // code-run rows, so skipping here is both cheaper and safer.
    return;
  }
  body.setAttribute('data-dpp-raw-text', visibleText);
  body.innerHTML = renderAgentStreamText(visibleText);
  followAgentStreamScroll(step);
}

export function updateStepStatus(step: HTMLElement, status: string): void {
  step.setAttribute('data-status', status);
}

// ---------------------------------------------------------------------------
// Incremental code-run support (native renderer does not run these): the
// DeepSeek presents html/svg/xml runnable blocks and Mermaid chart cards. The
// stored RESPONSE boundary converts xychart shorthand to Mermaid, so the plugin
// never renders any of those deliverables itself. For languages the native pipeline
// only renders as plain code
// (javascript/typescript/python) the agent console adds a run action that
// executes through the extension's sandbox runner — an increment on top of
// native rendering, never a replacement of it.
// ---------------------------------------------------------------------------
const AGENT_NATIVE_DELIVERABLE_CODE_LANGS = new Set([
  'html',
  'htm',
  'svg',
  'xml',
  'mermaid',
  'xychart',
  'xychart-beta',
]);
const AGENT_RUNNABLE_CODE_LANGS: Record<string, 'javascript' | 'typescript' | 'python'> = {
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  python: 'python',
  py: 'python',
};

export function renderAgentStreamText(text: string): string {
  return renderInlineMarkdown(text, {
    omitFencedCodeLanguages: AGENT_NATIVE_DELIVERABLE_CODE_LANGS,
  });
}

// ---------------------------------------------------------------------------
// Page scroll follow: while the agent streams, the chat scroller stays pinned
// to the bottom as long as the reader is already there; a reader who scrolled
// up is never yanked down. The scroller is discovered once by walking up from
// the stream and cached.
// ---------------------------------------------------------------------------
const AGENT_STREAM_SCROLL_FOLLOW_TOLERANCE_PX = 24;
let cachedAgentStreamScroller: HTMLElement | null | undefined;

function getAgentStreamScroller(stream: HTMLElement): HTMLElement | null {
  const cached = cachedAgentStreamScroller;
  if (cached !== undefined && cached !== null && cached.isConnected) return cached;
  let el: HTMLElement | null = stream.parentElement;
  while (el && el !== document.documentElement) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY)) {
        cachedAgentStreamScroller = el;
        return el;
      }
    }
    el = el.parentElement;
  }
  cachedAgentStreamScroller = null;
  return null;
}

function followAgentStreamScroll(stream: HTMLElement): void {
  const scroller = getAgentStreamScroller(stream);
  if (!scroller) return;
  const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distanceToBottom > AGENT_STREAM_SCROLL_FOLLOW_TOLERANCE_PX) return;
  scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Pins the chat scroller to the bottom after new stream content (narration
 * segments, appended answer segments) while the reader is already near it.
 */
export function followAgentStreamBottom(stream: HTMLElement): void {
  followAgentStreamScroll(stream);
}

// ---------------------------------------------------------------------------
// Native reasoning blocks: after the host finishes thinking (its title reads
// ("Thought (N s)"), the block is folded once by clicking the page's own
// title toggle. Idempotent per host, so a later manual expand is never
// re-folded, and the page's React state stays authoritative.
// ---------------------------------------------------------------------------
const REASONING_HOST_TEXT_RE = /^(?:已(?:深度)?思考|深度思考|思考过程|思考中|正在思考|thinking|reasoning|thought)(?:[\s（(:：]|$)/i;
const REASONING_COMPLETED_TEXT_RE = /^(?:已(?:深度)?思考|深度思考|思考过程|thought)(?:[\s（(:：]|$)/i;

function findReasoningHostTitle(host: HTMLElement): HTMLElement | null {
  // Prefer the most specific (shortest) matching descendant — the page's
  // title row — over the host container whose textContent also includes the
  // thinking body.
  let best: HTMLElement | null = null;
  for (const el of Array.from(host.querySelectorAll<HTMLElement>('*'))) {
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 80) continue;
    if (!REASONING_HOST_TEXT_RE.test(text)) continue;
    if (!best || text.length < (best.textContent ?? '').trim().length) best = el;
  }
  if (best) return best;
  // Fallback: the host itself when it carries the title text directly.
  const hostText = (host.textContent ?? '').trim();
  if (hostText && hostText.length <= 80 && REASONING_HOST_TEXT_RE.test(hostText)) return host;
  return null;
}

/**
 * Folds a completed native reasoning block once (Issue #551 follow-up). No-op
 * while the host is still thinking, and no-op after the first fold so the
 * user's own expand/collapse choices are never overridden.
 */
export function autoCollapseCompletedReasoningHost(host: HTMLElement): boolean {
  if (host.getAttribute('data-dpp-reasoning-auto-folded') === 'true') return false;
  const title = findReasoningHostTitle(host);
  if (!title) return false;
  const text = (title.textContent ?? '').trim();
  if (!REASONING_COMPLETED_TEXT_RE.test(text)) return false;
  host.setAttribute('data-dpp-reasoning-auto-folded', 'true');
  title.click();
  return true;
}

function createAgentToolGroup(stepIndex: number): HTMLElement {
  const group = document.createElement('div');
  group.className = 'dpp-agent-tool-group';
  group.setAttribute('data-step-index', String(stepIndex));
  group.setAttribute('data-collapsed', 'false');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dpp-agent-tool-group-toggle';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.addEventListener('click', () => {
    // Manual toggle: later auto-collapse must not override the user's choice.
    group.setAttribute('data-user-toggled', 'true');
    setAgentToolGroupCollapsed(group, group.getAttribute('data-collapsed') !== 'true');
  });

  const icon = document.createElement('span');
  icon.className = 'dpp-agent-tool-group-icon';
  icon.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'dpp-agent-tool-group-title';

  const chevron = document.createElement('span');
  chevron.className = 'dpp-agent-tool-group-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  toggle.appendChild(icon);
  toggle.appendChild(title);
  toggle.appendChild(chevron);

  const items = document.createElement('div');
  items.className = 'dpp-agent-tool-group-items';

  group.appendChild(toggle);
  group.appendChild(items);
  return group;
}

function updateAgentToolGroupCount(group: HTMLElement, labels?: Partial<InlineAgentRendererLabels>): void {
  const title = group.querySelector<HTMLElement>('.dpp-agent-tool-group-title');
  if (!title) return;
  const count = group.querySelectorAll('.dpp-agent-tool-item').length;
  title.textContent = labels?.toolGroup?.(count) ?? `Tool calls (${count})`;
}

function createAgentToolRow(
  toolName: string,
  paramSummary: string | null,
  status: 'pending' | 'ok' | 'err',
  labels?: Partial<InlineAgentRendererLabels>,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'dpp-agent-tool-item';
  item.setAttribute('data-tool-status', status);

  const summaryId = nextAgentDomId('dpp-agent-tool-summary');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dpp-agent-tool-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', summaryId);

  const icon = document.createElement('span');
  icon.className = 'dpp-agent-tool-state-icon';
  icon.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'dpp-agent-tool-name';
  name.textContent = toolName;

  const param = document.createElement('span');
  param.className = 'dpp-agent-tool-param';
  param.textContent = paramSummary ? `· ${paramSummary}` : '';

  const state = document.createElement('span');
  state.className = 'dpp-agent-tool-state';
  state.textContent = status === 'pending'
    ? ''
    : (status === 'ok' ? (labels?.toolOk ?? 'OK') : (labels?.toolError ?? 'Error'));

  const chevron = document.createElement('span');
  chevron.className = 'dpp-agent-tool-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  toggle.appendChild(icon);
  toggle.appendChild(name);
  toggle.appendChild(param);
  toggle.appendChild(state);
  toggle.appendChild(chevron);

  const detail = document.createElement('div');
  detail.className = 'dpp-agent-tool-summary';
  detail.id = summaryId;
  detail.hidden = true;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    detail.hidden = expanded;
  });

  item.appendChild(toggle);
  item.appendChild(detail);
  return item;
}

function appendToolRowToGroup(stream: HTMLElement, stepIndex: number, row: HTMLElement): HTMLElement {
  const state = getAgentStreamState(stream);
  let group = state.currentToolGroup;
  // The group must still belong to THIS stream (a re-mount through the
  // virtual list could have re-parented it otherwise).
  if (!group || group.parentElement !== stream) {
    group = createAgentToolGroup(stepIndex);
    stream.appendChild(group);
    state.currentToolGroup = group;
  }
  group.querySelector('.dpp-agent-tool-group-items')?.appendChild(row);
  return group;
}

/**
 * Renders one single-line tool entry when the model's tool call is detected
 * (status: pending). The row carries the payload parameter summary, sits in
 * the current tool group and is completed by
 * {@link resolveAgentToolEntry} once the execution result arrives.
 */
export function addAgentToolEntry(
  stream: HTMLElement,
  stepIndex: number,
  call: { name: string; payload?: unknown },
  labels?: Partial<InlineAgentRendererLabels>,
): HTMLElement {
  const row = createAgentToolRow(call.name, summarizeInlineAgentToolParams(call.payload), 'pending', labels);
  const group = appendToolRowToGroup(stream, stepIndex, row);
  updateAgentToolGroupCount(group, labels);

  const state = getAgentStreamState(stream);
  const rows = state.pendingRowsByStep.get(stepIndex) ?? [];
  rows.push(row);
  state.pendingRowsByStep.set(stepIndex, rows);
  return row;
}

/**
 * Completes the oldest pending tool entry of the step with its execution
 * result. When no pending row exists (restored traces, missed detection) a
 * completed row is created in the current group instead.
 */
export function resolveAgentToolEntry(
  stream: HTMLElement,
  stepIndex: number,
  execution: ToolExecutionRecord,
  labels?: Partial<InlineAgentRendererLabels>,
): void {
  const state = getAgentStreamState(stream);
  const pending = state.pendingRowsByStep.get(stepIndex) ?? [];
  const row = pending.shift();
  if (row && row.parentElement) {
    setAgentToolRowResult(row, execution, labels);
    return;
  }
  const paramFallback = execution.result.summary.trim();
  const completed = createAgentToolRow(
    execution.name,
    paramFallback || null,
    execution.result.ok ? 'ok' : 'err',
    labels,
  );
  const group = appendToolRowToGroup(stream, stepIndex, completed);
  updateAgentToolGroupCount(group, labels);
  setAgentToolRowResult(completed, execution, labels);
}

/**
 * Terminal-state cleanup: tool entries that were detected but never resolved
 * (loop aborted mid-step) switch from the pulsing "pending" state to a
 * neutral dot instead of blinking forever.
 */
export function finalizePendingAgentToolEntries(stream: HTMLElement): void {
  const state = agentStreamStates.get(stream);
  if (!state) return;
  for (const rows of state.pendingRowsByStep.values()) {
    for (const row of rows) {
      if (row.getAttribute('data-tool-status') !== 'pending') continue;
      row.setAttribute('data-tool-status', 'interrupted');
    }
  }
  state.pendingRowsByStep.clear();
}

function setAgentToolRowResult(
  row: HTMLElement,
  execution: ToolExecutionRecord,
  labels?: Partial<InlineAgentRendererLabels>,
): void {
  const { ok } = execution.result;
  row.setAttribute('data-tool-status', ok ? 'ok' : 'err');

  const state = row.querySelector<HTMLElement>('.dpp-agent-tool-state');
  if (state) state.textContent = ok ? (labels?.toolOk ?? 'OK') : (labels?.toolError ?? 'Error');

  const detail = row.querySelector<HTMLElement>('.dpp-agent-tool-summary');
  if (!detail) return;
  detail.textContent = getToolResultDetailText(execution.result);
  // Entries default to the collapsed single line; a user-expanded detail is
  // never force-closed, and an empty detail stays hidden either way.
  const userExpanded = row.querySelector('.dpp-agent-tool-toggle')?.getAttribute('aria-expanded') === 'true';
  detail.hidden = !(userExpanded && detail.textContent.length > 0);
}

function getToolResultDetailText(result: Pick<ToolResult, 'ok' | 'summary' | 'detail' | 'output' | 'error'>): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(result.summary);
    if (result.detail) lines.push(clampDisplayText(result.detail, 2000));
  } else {
    const reason = result.detail?.trim() || result.error?.message.trim() || '';
    if (!reason || reason === result.summary.trim()) {
      lines.push(result.summary);
    } else {
      lines.push(`${result.summary}\n${reason}`);
    }
    if (result.error) lines.push(`error: ${clampDisplayText(JSON.stringify(result.error), 2000)}`);
  }
  if (result.output !== undefined) {
    lines.push(`output: ${clampDisplayText(JSON.stringify(result.output), 4000)}`);
  }
  return lines.filter(Boolean).join('\n');
}

function clampDisplayText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

/**
 * "Starting" placeholder shown between container mount and the first step
 * (the loop waits 2.5-6.5s for the first model turn; without this the stream
 * appears dead) (Issue #544).
 */
