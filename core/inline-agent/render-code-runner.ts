/**
 * render-code-runner.ts — Inline-agent 代码运行器水合。
 * 职责：代码块执行 UI、AgentCodeRunResult/Runner 类型、hydrateAgentStepCodeRunners。
 */
import type { InlineAgentRendererLabels } from './render-console';
import type { ToolExecutionRecord, ToolResult } from '../types';

const AGENT_NATIVE_DELIVERABLE_CODE_LANGS = new Set([
  'html', 'svg', 'xml', 'mermaid',
]);

const AGENT_RUNNABLE_CODE_LANGS: Record<string, 'javascript' | 'typescript' | 'python'> = {
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  python: 'python',
  py: 'python',
};



export interface AgentCodeRunResult {
  ok: boolean;
  output?: unknown;
  detail?: string;
  error?: { message: string };
}

export type AgentCodeRunner = (
  code: string,
  language: 'javascript' | 'typescript' | 'python',
) => Promise<AgentCodeRunResult>;

function formatAgentCodeRunOutput(result: AgentCodeRunResult, labels?: Partial<InlineAgentRendererLabels>): string {
  const output = result.output && typeof result.output === 'object'
    ? result.output as Record<string, unknown>
    : {};
  const lines: string[] = [];
  if (!result.ok && result.error?.message) lines.push(`error: ${result.error.message}`);
  if (result.detail && !output.stdout && !output.stderr && !output.result) lines.push(result.detail);
  if (typeof output.stdout === 'string' && output.stdout) lines.push(`stdout:\n${output.stdout}`);
  if (typeof output.stderr === 'string' && output.stderr) lines.push(`stderr:\n${output.stderr}`);
  if (typeof output.result === 'string' && output.result) lines.push(`result:\n${output.result}`);
  const body = lines.filter(Boolean).join('\n\n');
  return body || (result.ok ? 'OK' : labels?.codeRunFailed ?? 'Run failed');
}

/**
 * Adds the incremental run action to every code block of a step body whose
 * language is NOT natively rendered by DeepSeek (see
 * {@link AGENT_RUNNABLE_CODE_LANGS}). Idempotent per block: re-running after
 * a stream update skips already-hydrated blocks. Never touches native
 * deliverables (html/svg/xml/mermaid or xychart shorthand).
 *
 * The step body is rebuilt on every stream chunk, which destroys hydrated
 * rows. In-flight and completed runs are remembered in a bounded module-level
 * map keyed by the code block's language+content hash, so a re-hydrated row
 * restores the disabled button and the output instead of silently losing the
 * sandbox result (the old rows wrote their output into detached nodes).
 */
export function hydrateAgentStepCodeRunners(
  step: HTMLElement,
  runCode: AgentCodeRunner,
  labels?: Partial<InlineAgentRendererLabels>,
): void {
  const body = step.querySelector<HTMLElement>('.dpp-agent-step-body');
  if (!body) return;
  for (const pre of body.querySelectorAll<HTMLElement>('pre[data-dpp-lang]')) {
    if (pre.hasAttribute('data-dpp-code-run-ready')) continue;
    const lang = (pre.getAttribute('data-dpp-lang') ?? '').trim().toLowerCase();
    if (!lang || AGENT_NATIVE_DELIVERABLE_CODE_LANGS.has(lang)) continue;
    const runnerLang = AGENT_RUNNABLE_CODE_LANGS[lang];
    if (!runnerLang) continue;
    pre.setAttribute('data-dpp-code-run-ready', 'true');

    const code = pre.querySelector('code')?.textContent ?? '';
    const key = getAgentCodeRunKey(code, runnerLang);
    const restored = agentCodeRunStates.get(key);

    const row = document.createElement('div');
    row.className = 'dpp-agent-code-run-row';
    row.dataset.dppRunKey = key;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dpp-agent-code-run';
    button.textContent = labels?.codeRun ?? 'Run';

    const output = document.createElement('div');
    output.className = 'dpp-agent-code-run-output';
    output.hidden = true;

    button.addEventListener('click', () => {
      if (button.disabled) return;
      const state: AgentCodeRunState = { running: true, output: '' };
      rememberAgentCodeRunState(key, state);
      syncAgentCodeRunRow(step, key, state, labels);
      void runCode(code, runnerLang)
        .then((result) => {
          state.output = formatAgentCodeRunOutput(result, labels);
        })
        .catch((error: unknown) => {
          state.output = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          state.running = false;
          // The row may have been destroyed and re-hydrated since the click;
          // sync whatever row currently exists for this key inside the step.
          syncAgentCodeRunRow(step, key, state, labels);
        });
    });

    row.appendChild(button);
    pre.insertAdjacentElement('afterend', row);
    row.insertAdjacentElement('afterend', output);
    if (restored) syncAgentCodeRunRow(step, key, restored, labels);
  }
}

/**
 * Applies a remembered code-run state to the current row for `key` inside the
 * step (a no-op when the row was destroyed and not re-hydrated yet).
 */
function syncAgentCodeRunRow(
  step: HTMLElement,
  key: string,
  state: AgentCodeRunState,
  labels?: Partial<InlineAgentRendererLabels>,
): void {
  const row = step.querySelector<HTMLElement>(`[data-dpp-run-key="${key}"]`);
  if (!row) return;
  const button = row.querySelector<HTMLButtonElement>('.dpp-agent-code-run');
  // The output box is the row's following sibling (the row is inserted
  // between the <pre> and the output box).
  const output = row.nextElementSibling instanceof HTMLElement
    && row.nextElementSibling.classList.contains('dpp-agent-code-run-output')
    ? row.nextElementSibling
    : null;
  if (button) {
    button.disabled = state.running;
    button.textContent = state.running
      ? (labels?.codeRunning ?? 'Running…')
      : (labels?.codeRun ?? 'Run');
  }
  if (output) {
    output.hidden = !state.running && !state.output;
    output.textContent = state.output;
  }
}

// ---------------------------------------------------------------------------
// Code-run state registry (bounded): survives step-body re-renders.
// ---------------------------------------------------------------------------

interface AgentCodeRunState {
  running: boolean;
  output: string;
}

const AGENT_CODE_RUN_STATE_MAX = 64;
const agentCodeRunStates = new Map<string, AgentCodeRunState>();

function getAgentCodeRunKey(code: string, language: string): string {
  let hash = 0x811c9dc5;
  const input = `${language}\0${code}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function rememberAgentCodeRunState(key: string, state: AgentCodeRunState): void {
  agentCodeRunStates.set(key, state);
  while (agentCodeRunStates.size > AGENT_CODE_RUN_STATE_MAX) {
    const oldest = agentCodeRunStates.keys().next().value;
    if (typeof oldest !== 'string') break;
    agentCodeRunStates.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Agent-stream text rendering: narration remains visible in the work log, but
// deliverable languages owned by DeepSeek's native renderer are deliberately
// omitted from this plugin DOM. Their complete Markdown bytes remain in the
// step's data-dpp-raw-text / trace and are delivered in the native final-answer
// message, where DeepSeek supplies language labels, highlighting, chart cards,
// and copy/download/run/preview interactions. Hiding both closed and streaming
// (unterminated) native fences prevents any plugin-owned grey code frame from
// flashing before native delivery. Non-native runnable languages keep the
// incremental sandbox action below.
// ---------------------------------------------------------------------------
