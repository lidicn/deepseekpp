/**
 * render-console.ts — Inline-agent 容器与控制台渲染。
 * 职责：容器创建、控制台头部更新、叙述挂载、起始元素、预算判断、标签类型。
 */
import { INLINE_AGENT_MAX_STEPS } from './types';
import { sealCurrentToolGroup, createAgentReasoningNoteElement } from './render-steps';

export interface InlineAgentRendererLabels {
  starting: string;
  stop: string;
  running: (stepNumber: number, toolCount: number, elapsedSeconds: number) => string;
  consoleComplete: (totalSteps: number, totalTools: number, elapsedSeconds: number) => string;
  consolePaused: (totalSteps: number, totalTools: number, elapsedSeconds: number) => string;
  consoleError: (totalSteps: number, totalTools: number, elapsedSeconds: number) => string;
  toolOk: string;
  toolError: string;
  /** Tool-group header, e.g. "Called 3 tools" (Codex-style work log). */
  toolGroup: (count: number) => string;
  /** Reasoning-step note header, e.g. "Thought · step 3" (folded by default). */
  reasoningStep: (stepNumber: number) => string;
  /** Explanation shown when a folded reasoning note is expanded. */
  reasoningNotPersisted: string;
  /** Run action on agent-console code blocks (incremental, non-native languages only). */
  codeRun: string;
  /** Run action while a console code block is executing. */
  codeRunning: string;
  /** Run action failure label. */
  codeRunFailed: string;
}

// ---------------------------------------------------------------------------
// Per-stream bookkeeping. The stream is a time-ordered sequence of narration
// segments and tool groups; tool entries are appended to the CURRENT group
// and consecutive tool calls without narration between them stay in one
// group. A narration segment seals the current group (and collapses it unless
// the user toggled it), so groups only span textless steps.
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

export function createAgentContainer(
  onStop?: () => void,
  labels?: Partial<InlineAgentRendererLabels>,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'dpp-agent-container';
  container.setAttribute('data-dpp-agent', 'true');
  container.setAttribute('data-console-phase', 'starting');

  const statusLine = document.createElement('div');
  statusLine.className = 'dpp-agent-status-line';

  const dot = document.createElement('span');
  dot.className = 'dpp-agent-status-dot';
  dot.setAttribute('aria-hidden', 'true');

  const status = document.createElement('span');
  status.className = 'dpp-agent-status-text';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = labels?.starting ?? 'Starting…';

  statusLine.appendChild(dot);
  statusLine.appendChild(status);

  if (onStop) {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'dpp-agent-stop-btn';
    stopBtn.textContent = labels?.stop ?? 'Stop';
    stopBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      onStop();
    });
    statusLine.appendChild(stopBtn);
  }

  const stream = document.createElement('div');
  stream.className = 'dpp-agent-stream';

  container.appendChild(statusLine);
  container.appendChild(stream);
  return container;
}

export function getAgentConsoleBody(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.dpp-agent-stream');
}

export type AgentConsolePhase = 'starting' | 'running' | 'complete' | 'paused' | 'error';

export interface AgentConsoleState {
  phase: AgentConsolePhase;
  /** 0-based current step number while running. */
  stepNumber: number;
  toolCount: number;
  totalSteps: number;
  totalTools: number;
  elapsedSeconds: number;
  /** Overrides the phase default text (e.g. the explicit stopped/error label). */
  labelOverride?: string;
}

export function updateAgentConsoleHeader(
  container: HTMLElement,
  state: AgentConsoleState,
  labels?: Partial<InlineAgentRendererLabels>,
): void {
  container.setAttribute('data-console-phase', state.phase);
  const status = container.querySelector<HTMLElement>('.dpp-agent-status-text');
  if (status) status.textContent = getAgentConsoleStatusText(state, labels);
  const stopBtn = container.querySelector<HTMLElement>('.dpp-agent-stop-btn');
  if (stopBtn) stopBtn.hidden = state.phase !== 'starting' && state.phase !== 'running';
}

function getAgentConsoleStatusText(
  state: AgentConsoleState,
  labels?: Partial<InlineAgentRendererLabels>,
): string {
  if (state.labelOverride) return state.labelOverride;
  switch (state.phase) {
    case 'starting':
      return labels?.starting ?? 'Starting…';
    case 'running':
      return labels?.running?.(state.stepNumber, state.toolCount, state.elapsedSeconds)
        ?? `Running · step ${state.stepNumber + 1} · ${state.toolCount} tool calls · ${state.elapsedSeconds}s`;
    case 'complete':
      return labels?.consoleComplete?.(state.totalSteps, state.totalTools, state.elapsedSeconds)
        ?? `Complete · ${state.totalSteps} steps · ${state.totalTools} tool calls · ${state.elapsedSeconds}s`;
    case 'paused':
      return labels?.consolePaused?.(state.totalSteps, state.totalTools, state.elapsedSeconds)
        ?? `Paused · ${state.totalSteps} steps · ${state.totalTools} tool calls · ${state.elapsedSeconds}s`;
    case 'error':
      return labels?.consoleError?.(state.totalSteps, state.totalTools, state.elapsedSeconds)
        ?? `Error · ${state.totalSteps} steps · ${state.totalTools} tool calls · ${state.elapsedSeconds}s`;
  }
}

/**
 * Visually adopts a native DeepSeek reasoning block into the agent stream
 * (Issue #551). CSS-only: the host DOM is never moved or re-parented, so host
 * React re-renders cannot lose extension state. Returns true when the class
 * was newly applied (idempotent, safe to call on every mutation).
 */
export function mountAgentNarration(
  step: HTMLElement,
  stream: HTMLElement,
  labels?: Partial<InlineAgentRendererLabels>,
  reasoningText?: string,
): void {
  if (step.parentElement === stream) return;
  sealCurrentToolGroup(stream);
  const stepIndex = Number(step.getAttribute('data-step-index') ?? 0);
  let insertBefore: HTMLElement | null = null;
  for (const child of Array.from(stream.children) as HTMLElement[]) {
    const childStepIndex = Number(child.getAttribute('data-step-index') ?? -1);
    if (childStepIndex >= stepIndex) {
      insertBefore = child;
      break;
    }
  }
  const note = createAgentReasoningNoteElement(stepIndex, labels, reasoningText);
  if (insertBefore) {
    stream.insertBefore(note, insertBefore);
    stream.insertBefore(step, insertBefore);
  } else {
    stream.appendChild(note);
    stream.appendChild(step);
  }
}

/**
 * Folded per-step reasoning note (default collapsed), mirroring the native
 * "Thought (N s)" row. The note body carries the real captured thinking text
 * when the backend delivered it; without it the body states plainly that the
 * step had no retained thinking instead of faking content.
 */
export function createAgentStartingElement(labels?: Partial<InlineAgentRendererLabels>): HTMLElement {
  const element = document.createElement('div');
  element.className = 'dpp-agent-starting';
  element.setAttribute('role', 'status');
  element.textContent = labels?.starting ?? 'Starting…';
  return element;
}

/**
 * True when `text` is exactly the budget-exhaustion notice for some completed
 * step count (1..maxSteps). The loop fabricates that notice by translating
 * `content.agent.budgetReached`, so the renderer recognizes it by
 * reconstructing the same strings instead of adding a wire-protocol field
 * (the AGENT_* protocol is byte-locked by the golden contract test). Used to
 * render the neutral "paused" footer instead of the green "complete" one for
 * budget-paused loops (Issue #541).
 *
 * The default range allows a +2 margin over {@link INLINE_AGENT_MAX_STEPS}:
 * the loop reports `stepIndex` (and `stepIndex + 1` on the nudge path) as the
 * completed-round count, so the notice can exceed maxSteps by one.
 */
export function isInlineAgentBudgetFinalText(
  text: string,
  budgetNoticeForCount: (count: number) => string,
  maxSteps: number = INLINE_AGENT_MAX_STEPS + 2,
): boolean {
  if (!text) return false;
  for (let count = 1; count <= maxSteps; count += 1) {
    if (text === budgetNoticeForCount(count)) return true;
  }
  return false;
}
