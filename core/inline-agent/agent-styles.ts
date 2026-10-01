/**
 * agent-styles.ts — Inline-agent DOM 样式注入。
 * 职责：CSS 模板字符串 + inject/remove 样式元素。
 */
import { injectInjectedThemeStyles } from '../ui/injected-theme';

const AGENT_STEP_STYLE_ID = 'dpp-inline-agent-css';

// ---------------------------------------------------------------------------
// Inline SVG icons (fill="currentColor" so each icon inherits the themed color
// of its container). Replaces the previous unicode glyphs (●⚙✓✗▼▸■) that
// rendered as emoji or jagged text on some platforms (Issue #544).
// ---------------------------------------------------------------------------
const svgDataUri = (body: string, viewBox = '0 0 24 24'): string =>
  `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor">${body}</svg>`,
  )}")`;
const ICON_CHECK = svgDataUri('<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>');
const ICON_CROSS = svgDataUri('<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>');
const ICON_GEAR = svgDataUri('<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>');
const ICON_CHEVRON_DOWN = svgDataUri('<path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>');
const ICON_CHEVRON_RIGHT = svgDataUri('<path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>');
export function injectInlineAgentStyles(): void {
  injectInjectedThemeStyles();
  if (document.getElementById(AGENT_STEP_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = AGENT_STEP_STYLE_ID;
  style.textContent = `
    /* The agent run renders as a lightweight work-log stream inside the
       assistant message (Issue #551 redesign): no card, no console shell,
       no answer-area split. A one-line status row, the narration body stream
       (never folded or truncated) and collapsed single-line tool entries. */
    .dpp-agent-container {
      position: relative;
      margin-top: 10px;
      color: var(--dpp-ui-text);
    }
    .dpp-agent-container[data-restored="true"] {
      margin-bottom: 10px;
    }
    .dpp-agent-status-line {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--dpp-ui-text-muted);
    }
    .dpp-agent-status-dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--dpp-ui-text-subtle);
    }
    .dpp-agent-container[data-console-phase="starting"] .dpp-agent-status-dot,
    .dpp-agent-container[data-console-phase="running"] .dpp-agent-status-dot {
      background: var(--dpp-ui-accent);
      animation: dpp-agent-console-pulse 1.1s ease-in-out infinite;
    }
    .dpp-agent-container[data-console-phase="complete"] .dpp-agent-status-dot {
      background: var(--dpp-ui-success);
    }
    .dpp-agent-container[data-console-phase="paused"] .dpp-agent-status-dot {
      background: var(--dpp-ui-text-subtle);
    }
    .dpp-agent-container[data-console-phase="error"] .dpp-agent-status-dot {
      background: var(--dpp-ui-error);
    }
    @keyframes dpp-agent-console-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .dpp-agent-status-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dpp-agent-container[data-console-phase="error"] .dpp-agent-status-text {
      color: var(--dpp-ui-error);
    }
    .dpp-agent-stop-btn {
      flex: none;
      padding: 2px 9px;
      font-size: 12px;
      border: 1px solid var(--dpp-ui-error);
      border-radius: 6px;
      background: transparent;
      color: var(--dpp-ui-error);
      cursor: pointer;
    }
    .dpp-agent-stop-btn:hover {
      background: var(--dpp-ui-danger-panel);
    }
    .dpp-agent-stop-btn:focus-visible {
      outline: 2px solid var(--dpp-ui-error);
      outline-offset: 1px;
    }
    /* Narration body stream: normal message typography, never folded. */
    .dpp-agent-stream {
      /* Pure flow container: segments stack in time order, no card shell. */
    }
    .dpp-agent-narration {
      margin: 4px 0 6px;
    }
    .dpp-agent-step-body {
      font-size: 14px;
      line-height: 1.7;
      color: var(--dpp-ui-text);
      word-break: break-word;
    }
    .dpp-agent-step-body:empty {
      display: none;
    }
    .dpp-agent-step-body * { color: inherit; }
    .dpp-agent-step-body h2,
    .dpp-agent-step-body h3,
    .dpp-agent-step-body h4 {
      margin: 8px 0 5px;
      font-weight: 600;
      line-height: 1.35;
    }
    .dpp-agent-step-body h2 { font-size: 1.1em; }
    .dpp-agent-step-body h3,
    .dpp-agent-step-body h4 { font-size: 1.02em; }
    .dpp-agent-step-body p { margin: 4px 0; }
    .dpp-agent-step-body ul,
    .dpp-agent-step-body ol {
      margin: 4px 0 4px 18px;
    }
    .dpp-agent-step-body li {
      margin: 2px 0;
    }
    .dpp-agent-step-body strong {
      font-weight: 600;
    }
    .dpp-agent-step-body em {
      font-style: italic;
    }
    .dpp-agent-step-body code {
      padding: 1px 4px;
      border-radius: 6px;
      background: var(--dpp-ui-code-bg);
      font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    .dpp-agent-step-body pre {
      margin: 6px 0;
      padding: 8px;
      border-radius: 8px;
      background: var(--dpp-ui-code-bg);
      overflow-x: auto;
    }
    .dpp-agent-step-body pre code {
      padding: 0;
      background: transparent;
      white-space: pre;
    }
    .dpp-agent-step-body table {
      width: 100%;
      margin: 8px 0;
      border-collapse: collapse;
      font-size: 12px;
    }
    .dpp-agent-step-body th,
    .dpp-agent-step-body td {
      padding: 5px 6px;
      border-bottom: 1px solid var(--dpp-ui-border);
      text-align: left;
      vertical-align: top;
    }
    .dpp-agent-step-body th {
      font-weight: 600;
      color: var(--dpp-ui-text-muted);
    }
    /* Tool groups: one-line low-emphasis headers over single-line tool rows. */
    .dpp-agent-tool-group {
      margin: 2px 0;
    }
    .dpp-agent-tool-group-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 2px 0;
      border: none;
      background: transparent;
      font-size: 12px;
      color: var(--dpp-ui-text-muted);
      cursor: pointer;
      user-select: none;
      text-align: left;
    }
    .dpp-agent-tool-group-toggle:focus-visible {
      outline: 2px solid var(--dpp-ui-accent);
      outline-offset: -2px;
      border-radius: 4px;
    }
    .dpp-agent-tool-group-icon {
      flex: none;
      width: 12px;
      height: 12px;
      background-image: ${ICON_GEAR};
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
      color: var(--dpp-ui-text-subtle);
    }
    .dpp-agent-tool-group-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dpp-agent-tool-group-chevron {
      flex: none;
      width: 12px;
      height: 12px;
      background-image: ${ICON_CHEVRON_DOWN};
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
      color: var(--dpp-ui-text-subtle);
      transition: transform 0.2s ease;
    }
    .dpp-agent-tool-group[data-collapsed="true"] .dpp-agent-tool-group-chevron {
      transform: rotate(-90deg);
    }
    .dpp-agent-tool-group[data-collapsed="true"] .dpp-agent-tool-group-items {
      display: none;
    }
    .dpp-agent-tool-group-items {
      display: flex;
      flex-direction: column;
    }
    /* Single-line tool entries (small, gray, left icon). */
    .dpp-agent-tool-item {
      min-width: 0;
    }
    .dpp-agent-tool-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 1px 0;
      border: none;
      background: transparent;
      font-size: 12px;
      color: var(--dpp-ui-text-muted);
      cursor: pointer;
      user-select: none;
      text-align: left;
    }
    .dpp-agent-tool-toggle:focus-visible {
      outline: 2px solid var(--dpp-ui-accent);
      outline-offset: -2px;
      border-radius: 4px;
    }
    .dpp-agent-tool-state-icon {
      flex: none;
      width: 12px;
      height: 12px;
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
    }
    .dpp-agent-tool-item[data-tool-status="ok"] .dpp-agent-tool-state-icon {
      background-image: ${ICON_CHECK};
      color: var(--dpp-ui-success);
    }
    .dpp-agent-tool-item[data-tool-status="err"] .dpp-agent-tool-state-icon {
      background-image: ${ICON_CROSS};
      color: var(--dpp-ui-error);
    }
    .dpp-agent-tool-item[data-tool-status="pending"] .dpp-agent-tool-state-icon {
      background-color: var(--dpp-ui-accent);
      border-radius: 50%;
      animation: dpp-agent-console-pulse 1.1s ease-in-out infinite;
    }
    .dpp-agent-tool-item[data-tool-status="interrupted"] .dpp-agent-tool-state-icon {
      background-color: var(--dpp-ui-text-subtle);
      border-radius: 50%;
    }
    .dpp-agent-tool-name {
      flex: none;
      max-width: 45%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      color: var(--dpp-ui-text);
    }
    .dpp-agent-tool-param {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dpp-agent-tool-state {
      flex: none;
      font-size: 11px;
      color: var(--dpp-ui-text-subtle);
    }
    .dpp-agent-tool-chevron {
      flex: none;
      width: 10px;
      height: 10px;
      background-image: ${ICON_CHEVRON_RIGHT};
      background-repeat: no-repeat;
      background-position: center;
      background-size: 10px 10px;
      color: var(--dpp-ui-text-subtle);
      transition: transform 0.15s ease;
    }
    .dpp-agent-tool-toggle[aria-expanded="true"] .dpp-agent-tool-chevron {
      transform: rotate(90deg);
    }
    .dpp-agent-tool-summary {
      padding: 2px 0 4px 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--dpp-ui-text-muted);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 160px;
      overflow-y: auto;
    }
    /*
     * Adopted native reasoning host (the FIRST native turn's thought block,
     * e.g. "Thought (N s)"): aligned with the agent step flow. The adoption
     * is CSS-only — the host DOM is never moved — and the class only
     * neutralizes indent chrome (plugin's own and the host-level native one)
     * so the block sits at the same left edge and visual level as the
     * reasoning notes / tool groups of the agent stream: the whole run record
     * reads as one flow (Issue: unified agent run record). Content and
     * interaction (the native fold toggle) are untouched.
     */
    .dpp-agent-reasoning-adopted {
      margin: 2px 0;
      padding-left: 0;
      border-left: none;
    }
    /* Reasoning notes: real captured thinking text, expanded on click. */
    .dpp-agent-reasoning-note {
      margin: 2px 0;
    }
    .dpp-agent-reasoning-note-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 2px 0;
      border: none;
      background: transparent;
      font-size: 12px;
      color: var(--dpp-ui-text-muted);
      cursor: pointer;
      user-select: none;
      text-align: left;
    }
    .dpp-agent-reasoning-note-toggle:focus-visible {
      outline: 2px solid var(--dpp-ui-accent);
      outline-offset: -2px;
      border-radius: 4px;
    }
    .dpp-agent-reasoning-note-icon {
      flex: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--dpp-ui-accent);
      opacity: 0.55;
    }
    .dpp-agent-reasoning-note-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dpp-agent-reasoning-note-chevron {
      flex: none;
      width: 12px;
      height: 12px;
      background-image: ${ICON_CHEVRON_DOWN};
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
      color: var(--dpp-ui-text-subtle);
      transition: transform 0.15s ease;
    }
    .dpp-agent-reasoning-note-toggle[aria-expanded="true"] .dpp-agent-reasoning-note-chevron {
      transform: rotate(180deg);
    }
    .dpp-agent-reasoning-note-body {
      padding: 2px 0 4px 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--dpp-ui-text-muted);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow-y: auto;
    }
    .dpp-agent-starting {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 13px;
      color: var(--dpp-ui-text-muted);
    }
    /* Incremental code-run support (non-native languages only): DeepSeek owns
       html/svg/xml/mermaid presentation, while history cleanup normalizes
       xychart shorthand to Mermaid. The agent console only adds a run action to code
       blocks whose language the
       native pipeline does not run (javascript/typescript/python). */
    .dpp-agent-code-run-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 2px 0 6px;
    }
    .dpp-agent-code-run {
      padding: 2px 10px;
      font-size: 12px;
      line-height: 1.6;
      border: 1px solid var(--dpp-ui-border);
      border-radius: 6px;
      background: var(--dpp-ui-surface-muted);
      color: var(--dpp-ui-text);
      cursor: pointer;
    }
    .dpp-agent-code-run:hover {
      border-color: var(--dpp-ui-accent);
      color: var(--dpp-ui-accent);
    }
    .dpp-agent-code-run:focus-visible {
      outline: 2px solid var(--dpp-ui-accent);
      outline-offset: 1px;
    }
    .dpp-agent-code-run:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .dpp-agent-code-run-output {
      margin: 0 0 6px;
      padding: 6px 8px;
      border-radius: 8px;
      background: var(--dpp-ui-accent-panel);
      color: var(--dpp-ui-text-muted);
      font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow-y: auto;
    }
    .dpp-agent-starting::before {
      content: '';
      flex: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid var(--dpp-ui-accent-panel);
      border-top-color: var(--dpp-ui-accent);
      animation: dpp-agent-starting-spin 0.8s linear infinite;
    }
    @keyframes dpp-agent-starting-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .dpp-agent-starting::before,
      .dpp-agent-container[data-console-phase="starting"] .dpp-agent-status-dot,
      .dpp-agent-container[data-console-phase="running"] .dpp-agent-status-dot,
      .dpp-agent-tool-item[data-tool-status="pending"] .dpp-agent-tool-state-icon {
        animation: none;
      }
      .dpp-agent-tool-group-chevron,
      .dpp-agent-tool-chevron {
        transition: none;
      }
    }
  `;
  document.head.appendChild(style);
}

export function removeInlineAgentStyles(): void {
  document.getElementById(AGENT_STEP_STYLE_ID)?.remove();
}

