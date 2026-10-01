/**
 * renderer.ts — Inline-agent DOM 渲染门面（re-export 兼容层）。
 * 原 51.6KB 巨石已拆分为 agent-styles / render-console / render-steps / render-code-runner。
 * 本文件保留所有原始导出符号，确保 entrypoints/content.ts 和测试文件的 import 路径不变。
 */
export { injectInlineAgentStyles, removeInlineAgentStyles } from './agent-styles';
export type { InlineAgentRendererLabels } from './render-console';
export {
  createAgentContainer,
  getAgentConsoleBody,
  updateAgentConsoleHeader,
  mountAgentNarration,
  createAgentStartingElement,
  isInlineAgentBudgetFinalText,
} from './render-console';
export type { AgentConsolePhase, AgentConsoleState } from './render-console';
export {
  adoptReasoningBlock,
  createAgentStepElement,
  createAgentReasoningNoteElement,
  updateAgentReasoningNoteElement,
  getAgentReasoningNote,
  collapseAllAgentToolGroups,
  updateStepStreamText,
  updateStepStatus,
  renderAgentStreamText,
  followAgentStreamBottom,
  autoCollapseCompletedReasoningHost,
  addAgentToolEntry,
  resolveAgentToolEntry,
  finalizePendingAgentToolEntries,
} from './render-steps';
export type { AgentCodeRunResult, AgentCodeRunner } from './render-code-runner';
export { hydrateAgentStepCodeRunners } from './render-code-runner';
