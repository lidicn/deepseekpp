import type {
  BackgroundConfig,
  DeepSeekTheme,
  Memory,
  ModelType,
  PetConfig,
  PetCustomPosition,
  PromptInjectionSettings,
  Skill,
  SystemPromptPreset,
  McpServerConfig,
  ToolCall,
  ToolCardResult,
  ToolCallRestoreRecord,
  ToolAuthorizationGrantSummary,
  ToolDescriptor,
  ToolExecutionRecord,
} from "../core/types";
import {
  startRemoteAgentWatcher,
  stopRemoteAgentWatcher,
  recordLocalSendFromActiveInput,
  recordLocalSentMessage,
} from "../core/remote-agent/watcher";
import {
  applyTelemetryGate,
  readTelemetrySetting,
  TELEMETRY_SETTING_STORAGE_KEY,
} from "../core/debug/telemetry-gate";
import { refactorTelemetry } from "../core/debug/refactor-telemetry";
import { getDeepSeekApiKey } from "../core/chat/api-key";
import { normalizePetConfig } from "../core/pet/config";
import { pickPetLine, type PetState } from "../core/pet/lines";
import { createToolInvocationCatalog } from "../core/tool/invocation";
import { projectToolDescriptorsForNativeSearch } from "../core/tool/native-search-projection";
import {
  createLatestSyncGate,
  type LatestSyncLease,
} from "../core/tool/latest-sync";
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
} from "../core/prompt/settings";
import { normalizeBackgroundConfig } from "../core/background/config";
import { decodePersistedMemoryRecord } from "../core/memory/codec";
import { decodeActivePreset } from "../core/preset/codec";
import { decodeSkillLibrary } from "../core/skill/codec";
import {
  decodeRuntimeResponse,
  isRuntimeFailure,
} from "../core/messaging/runtime-response";
import {
  LEGACY_TOOL_CALLS_OPEN_TAG,
  stripToolCalls,
} from "../core/interceptor/tool-parser";
import {
  augmentDecodedRequestBody,
  decodeAugmentableDeepSeekRequest,
  type DeepSeekRequestBody,
  type DeepSeekRegenerateRequestBody,
} from "../core/interceptor/request-augmentation";
import { isDeepSeekAugmentableWebRoute } from "../core/deepseek/request-codec";
import {
  REGENERATE_AUTHORIZATION_METADATA_KEY,
  createPersistedRegenerateAuthorizationMetadata,
  createRegenerateAuthorizationScopeStore,
  resolvePersistedRegenerateAuthorizationEvidence,
  type RegenerateAuthorizationScope,
  type RegeneratePromptOptionsSnapshot,
} from "../core/interceptor/regenerate-authorization-scope";
import {
  DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS,
  normalizeSkillAutoActivationSettings,
  type SkillAutoActivationSettings,
} from "../core/skill/auto-activation-settings";
import {
  containsInternalPromptMarker,
  sanitizeInternalPromptText,
} from "../core/prompt";
import { createRestoredArtifactToolResult } from "../core/artifact";
import {
  type ResponseCompletePayload,
  type ResponseTokenSpeedPayload,
} from "../core/interceptor/fetch-hook";
import { shouldIgnoreEmptyTokenSpeedProgress } from "../core/deepseek/stream-metrics";
import { readDeepSeekChatSessionId } from "../core/deepseek/chat-session";
import { createUsageProgressWriteCoordinator } from "../core/usage/progress-write-coordinator";
import { runInlineAgentLoop } from "../core/inline-agent/loop";
import { waitForInlineAgentLiveTarget } from "../core/inline-agent/live-target-wait";
import {
  isInlineAgentNativeHistoryBackedTrace,
  shouldReloadInlineAgentNativeHistory,
  type InlineAgentModelBackend,
} from "../core/inline-agent/native-history";
import { shouldRenderNarration } from "../core/inline-agent/narration-dedup";
import {
  consumeNativeHistoryReload,
  hasPendingNativeReload,
  requestNativeHistoryReload,
} from "../core/inline-agent/native-reload";
import {
  INCOMPLETE_TOOL_CALL_ERROR_CODE,
  selectContinuableToolExecutions,
  filterContinuableToolDescriptors,
} from "../core/inline-agent/execution-policy";
import {
  INLINE_AGENT_CONTINUATION_PLACEHOLDER,
  isInlineAgentContinuationRequest,
  isInlineAgentContinuationStructure,
  replaceTaskCompleteBlocks,
} from "../core/inline-agent/prompt";
import {
  getInlineAgentDisplayFinalText,
  getInlineAgentDisplayStepText,
  resolveInlineAgentAnswerText,
  stripInlineAgentTruncationSuffix,
} from "../core/inline-agent/display-text";
import {
  hasVisibleToolCards,
  revealToolDetails as revealToolDetailsCore,
} from "../core/inline-agent/tool-details-reveal";
import {
  collectAssistantMessages,
  elementHasMessageId,
  findAssistantMessageByContentSnippet,
  findInlineAgentRestoreTarget,
} from "../core/inline-agent/message-anchor";
import { classifyEmptyAnswer, hasAssistantMessage, readLastAssistantAnswerText, shouldWarnEmptyAnswer } from "../core/inline-agent/empty-answer";
import { readLastAnswerLength } from "../core/inline-agent/stall-watchdog";
import { decideAutoContinueBudget, decideChatLayerContinuation, decideStallRecovery, isSuspiciouslyShortAnswer, shouldShowStallNotice } from "../core/inline-agent/plan-only-answer";
import { resolveTerminalHeader } from "../core/inline-agent/terminal-header";
import { diagnosticLogBuffer } from "../core/diagnostics/log-buffer";
import { decideRestoreStepAction, routeFinalAnswer, traceOwnsFinalTurn } from "../core/inline-agent/final-answer-routing";
import { applyFinalAnswerAction } from "../core/inline-agent/apply-final-answer";
import { probePageRenderState } from "../core/inline-agent/page-render-state";
import { createSerializedQueue } from "../core/persistence/serialized-queue";
import type {
  InlineAgentStartPayload,
  InlineAgentReasoningChunkMsg,
  InlineAgentStreamChunkMsg,
  InlineAgentStepCompleteMsg,
  InlineAgentToolDetectedMsg,
  InlineAgentLoopCompleteMsg,
  InlineAgentLoopErrorMsg,
  InlineAgentTraceRecord,
  InlineAgentTraceStepRecord,
} from "../core/inline-agent/types";
import {
  injectInlineAgentStyles,
  removeInlineAgentStyles,
  createAgentContainer,
  createAgentStepElement,
  mountAgentNarration,
  updateStepStreamText,
  clearStepBodyText,
  updateStepStatus,
  updateAgentReasoningNoteElement,
  getAgentReasoningNote,
  addAgentToolEntry,
  resolveAgentToolEntry,
  finalizePendingAgentToolEntries,
  collapseAllAgentToolGroups,
  autoCollapseCompletedReasoningHost,
  followAgentStreamBottom,
  renderAgentStreamText,
  adoptReasoningBlock,
  hydrateAgentStepCodeRunners,
  getAgentConsoleBody,
  updateAgentConsoleHeader,
  createAgentStartingElement,
  isInlineAgentBudgetFinalText,
  type AgentConsolePhase,
} from "../core/inline-agent/renderer";
import { renderInlineMarkdown } from "../core/inline-agent/markdown";
import {
  createTranslator,
  DEFAULT_LOCALE,
  type LocaleMessageKey,
  type MessageParams,
  type SupportedLocale,
} from "../core/i18n";
import {
  getResolvedLocaleState,
  watchLocalePreference,
} from "../core/i18n/store";
import {
  registerDefaultToolResultRenderers,
  renderToolResultWithRegistry,
} from "../core/ui/tool-result-renderer";
import { injectInjectedThemeStyles } from "../core/ui/injected-theme";
import {
  findPromptTextarea,
  insertTextIntoPromptTextarea,
} from "../core/ui/prompt-text-insertion";
import {
  normalizeRestoredToolExecution,
  sanitizeToolExecutionForRestoreStorage,
} from "../core/tool/execution-restore";
import type { PersistedToolExecutionBlock as PersistedToolBlock } from "../core/tool/execution-block-codec";
import {
  readPersistedToolExecutionBlocks,
  upsertPersistedToolExecutionBlock,
} from "../core/tool/execution-block-store";
import {
  readPersistedInlineAgentTraces,
  upsertPersistedInlineAgentTrace,
} from "../core/inline-agent/trace-store";
import {
  createTurnTracker,
  type TurnTracker,
} from "../core/trace/turn-tracker";
import { setTraceEventSink } from "../core/trace/collector";

/**
 * 2026-10-21 观测：inline agent 是否启动、没启动是卡在哪个分支。
 *
 * 真机验收发现「工具确实执行了，但 runInlineAgentLoop 从未进入」
 * （agent_loop_entered 一次都没出现、轨迹冻结在 10-18）。而工具执行的
 * 唯一续轮入口就是 startInlineAgentIfNeeded —— 它有三个早退分支，
 * 之前全部只写 console.log（页面一刷新就没了），所以无法定位。
 *
 * 为什么用独立存储键而不是 diagnosticLogBuffer：
 * 诊断缓冲是「每上下文一份」的内存快照，content script 若直接写同一个键，
 * 会用自己加载时的旧快照覆盖 SW 期间新增的条目（跨上下文互相覆盖）。
 * 独立键只有 content 一个写入者，append-only，天然不会覆盖 SW 的日志；
 * 读取侧（GET_DIAGNOSTIC_SNAPSHOT）把两个键按时间合并即可。
 */
const CONTENT_DIAGNOSTIC_STORAGE_KEY = "dpp_content_diagnostics";
const CONTENT_DIAGNOSTIC_LIMIT = 120;

/**
 * 诊断写入的串行化队列。
 *
 * 2026-10-22 真机定位：原实现是裸的 read-modify-write，**没有串行化**：
 *
 *   void chrome.storage.local.get(KEY).then((data) => {
 *     const next = [...prev, entry].slice(-LIMIT);
 *     return chrome.storage.local.set({ [KEY]: next });
 *   });
 *
 * 两个几乎同时发起的写入会互相吞掉：
 *   A 读 [x] → B 读 [x] → A 写 [x,A] → B 写 [x,B]   ← A 的条目丢失
 *
 * 实证：加了两阶段锚点等待后，探针能证明延长窗确实跑了
 * （`anchor_find_probe` 里 waitMs 从 15000 变成 120000），
 * 但配套的 `anchor_extended_wait` 条目**从未落盘** —— 它被并发的
 * `anchor_find_probe` 写入覆盖了。整个排查过程中大量「诊断缺失」
 * 都是这个竞态造成的，而不是探针没触发。
 *
 * 这里用一条 promise 链把写入排成序。竞态源自同一个 content script 实例，
 * 所以进程内串行化就够了，不需要全局的 withSyncLocalStateLock
 * （那个还会触发 recoverRequiredLocalStateAlreadyLocked，对诊断太重）。
 */
const contentDiagnosticQueue = createSerializedQueue();

function recordAgentStartDecision(outcome: string, details: string): void {
  try {
    void contentDiagnosticQueue(async () => {
      const data = await chrome.storage.local.get(CONTENT_DIAGNOSTIC_STORAGE_KEY);
      const raw = data?.[CONTENT_DIAGNOSTIC_STORAGE_KEY];
      const prev = Array.isArray(raw) ? raw : [];
      const next = [
        ...prev,
        {
          ts: Date.now(),
          level: outcome.startsWith("skipped") ? "warn" : "info",
          source: "inline-agent",
          message: `agent_start:${outcome}`,
          details,
        },
      ].slice(-CONTENT_DIAGNOSTIC_LIMIT);
      await chrome.storage.local.set({
        [CONTENT_DIAGNOSTIC_STORAGE_KEY]: next,
      });
    });
  } catch {
    // chrome.storage 不可用时静默跳过。
  }
}
import {
  chainExternalizedPayloadWrite,
  isExternalizedToolPayloadCall,
} from "../core/tool/externalized-payload";
import {
  createToolRestoreBlockId,
  createToolRestoreBlockIdCandidates,
  createToolRestoreBlockUrl,
} from "../core/tool/restore-block";
import { PendingRequestRegistry } from "../core/tool/pending-request-registry";
import { PendingAuthorizationCorrelations } from "../core/tool/pending-authorization-correlations";
import { shouldRequestWebFetchPermission } from "../core/tool/web-fetch-permission";
import {
  MCP_CAPABILITY_TOOL_PROVIDER_ID,
  isMcpCapabilityDescriptor,
} from "../core/mcp/capability-contract";
import {
  BACKGROUND_RUNTIME_PATHNAMES,
  createExtensionRuntimeMessageContext,
  decodeRuntimeMessageEnvelope,
  RuntimeBoundaryError,
} from "../core/messaging/runtime-boundary";
import {
  isToolDescriptorRecord,
  isToolProviderIdentity,
} from "../core/messaging/tool-record-codec";
import {
  startDeepSeekHistoryOrganizer,
  type HistoryOrganizerController,
} from "./content/adapters/history-organizer";
import {
  startDeepSeekProjectSidebarOrganizer,
  type ProjectSidebarOrganizerController,
} from "./content/adapters/project-sidebar-organizer";
import {
  MULTIMODAL_MEDIA_IMAGE_MAX_BYTES,
  MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN,
  MULTIMODAL_MEDIA_VIDEO_INLINE_MAX_BYTES,
  buildMultimodalAnalysisPrompt,
  hasDeepSeekChatSessionRoute,
  selectMultimodalMediaRouteKeyForRequest,
  shouldPreserveInitialMultimodalMediaRoute,
  type MultimodalMediaAnalyzeResponse,
  type MultimodalMediaInput,
  type MultimodalMediaKind,
} from "../core/multimodal/media";
import {
  calculateMultimodalRequestAugmentationTimeoutMs,
  canUseMultimodalMediaInput,
} from "../core/multimodal";

import {
  buildDeepSeekSessionUrl,
  createClientHeaders,
  rememberDeepSeekClientHeaders,
  saveClientHeadersToStorage,
} from "../core/deepseek/adapter";
import type {
  ConversationExportArtifact,
  ConversationExportContentScope,
  ConversationExportProgress,
  ConversationExportResult,
} from "../core/export/types";
import { createConversationExportArchiveArtifact } from "../core/export/zip";
import type { ToolCallPayloadChunk } from "../core/interceptor/streaming-tool-call-parser";
import {
  replaceContentDocumentLifecycle,
  type ContentCapabilityController,
  type ContentDocumentLifecycle,
  type ContentResourceScope,
} from "./content/lifecycle";
import {
  createIsolatedBridgeController,
  type IsolatedBridgeController,
} from "./content/controllers/isolated-bridge-controller";
import { createDomCapabilityController } from "./content/controllers/dom-capability-controller";
import { createContentChatController } from "./content/controllers/chat-controller";
import {
  createContentMutationHub,
  type ContentMutationHub,
} from "./content/controllers/mutation-hub";
import { notifyContentAuthStatusChanged } from "./content/auth-status-notifier";
import { createContentPersistenceTracker } from "./content/persistence-tracking";
import { getRestoredMessageMutationAction } from "./content/restored-message-targets";
import {
  bindNewChatToolCallToBrowserSession,
  waitForBrowserOwnedChatSession,
  TOOL_SESSION_BINDING_TIMEOUT_MS,
} from "./content/tool-session-binding";
import {
  createBrowserDownloadManager,
  type BrowserDownloadManager,
} from "./content/download-manager";

const TOOL_BLOCK_ID = "dpp-tool-block";
const TOOL_BLOCK_STYLE_ID = "dpp-tool-block-css";
const RESTORED_TOOL_UI_SELECTOR = ".dpp-tool-block, .dpp-artifact-results";
const RESTORED_INLINE_AGENT_UI_SELECTOR =
  '.dpp-agent-container[data-restored="true"]';
const ASSISTANT_RESPONSE_CONTENT_SELECTOR =
  "._74c0879, .ds-assistant-message-main-content";
const REASONING_HOST_META_RE =
  /\b(?:reason|reasoning|think|thinking|thought)\b/i;
const REASONING_HOST_TEXT_RE =
  /^(?:已(?:深度)?思考|深度思考|思考过程|思考中|正在思考|thinking|reasoning|thought)(?:[\s（(:：]|$)/i;
const REASONING_HOST_ANCESTOR_SCAN_DEPTH = 4;
/**
 * Matches user prompts that explicitly ask the model to continue an
 * interrupted response. When detected, startInlineAgentIfNeeded will launch
 * the agent loop even without prior tool executions — pure-text "继续完成"
 * prompts were previously silently skipped (断流 root cause).
 */
// R5 修复：前缀匹配，允许尾部内容（如"继续完成这个报告"）。
// 原正则 ^...$ 严格全匹配，用户换个说法就命中不了，R1 的静默跳过直接暴露。
const USER_CONTINUATION_RE =
  /^(?:继续(?:完成|往下|接着|说|写|生成)?|接着(?:说|写|继续|往下)|往下(?:说|写|继续)|go on|continue(?: writing| speaking| generating)?|keep going|next(?: please)?)/i;
/**
 * 等待锚点 assistant 消息落地的上限。
 *
 * 2026-10-21 真机定位：原值 1.5s 太短。诊断实测
 * `agent_start:skipped:anchor_not_located | located=false scopeMatch=true
 *  scopeActive=true waitMs=1500` —— scope 健康，纯粹是等不及。
 * DeepSeek 现在是虚拟列表（`.ds-virtual-list--printable`），提交是异步的；
 * 再叠加「深度思考」模式的思考阶段，1.5s 内 assistant 消息常常还没进 DOM。
 *
 * 结果是锚点找不到 → 弹「Agent 启动失败」→ 在创建 trace 之前就 return，
 * 于是「工具执行成功了却什么都没留下」，也永远看不到 W29 报告。
 *
 * 提到 15s：waitForInlineAgentLiveTarget 是 MutationObserver 驱动的，
 * 目标一出现就立刻 settle，所以放大上限不会拖慢正常路径，只是放宽下限。
 *
 * 注意：实测放大到 15s 后 located 仍为 false，所以这不是根因，
 * 真正原因见 anchor_find_probe 的诊断输出。
 */
const INLINE_AGENT_LIVE_TARGET_WAIT_MS = 15_000;
/** anchor_find_probe 的限流计数，避免每帧都写存储。 */
let anchorFindProbeCount = 0;
/**
 * 上一次完整锚点扫描的时间戳，用作限流。
 * 观测根是 document.documentElement，childList+subtree 会收到整页每次 DOM
 * 变更；用时间间隔限流，把昂贵的 getAssistantMessages() 全量扫描降到
 * 每 MIN_FIND_SCAN_INTERVAL_MS 一次。
 */
let lastFindScanAt = 0;
/** find() 完整扫描的最小间隔（毫秒）。 */
const MIN_FIND_SCAN_INTERVAL_MS = 150;

/**
 * 延长等待窗。
 *
 * 2026-10-22 真机定位（关键）：DeepSeek 新建/刷新对话后，**要 30–90 秒**
 * 才把消息渲染进虚拟列表（正常应 1–3 秒）。实测：硬刷新后 `.ds-message`
 * 保持 0 达 32 秒；同一会话过 45 秒再测已恢复为 2 条。
 *
 * 而原来的快速窗只有 15 秒 —— 必然超时 → 弹「Agent 启动失败，请重试」，
 * 但那时工具其实已经执行成功了（SW 诊断有 tool start/finished ok），
 * 只是 DOM 里什么都没有、没有可锚定的对象。
 *
 * 这不是扩展的 bug，是页面渲染慢的症状；所以不该报「失败」，
 * 而应该用中性提示继续等。
 */
const INLINE_AGENT_EXTENDED_TARGET_WAIT_MS = 120_000;
const TOKEN_SPEED_BADGE_ID = "dpp-token-speed-badge";
const TOKEN_SPEED_STYLE_ID = "dpp-token-speed-css";
const MULTIMODAL_MEDIA_BUTTON_ID = "dpp-multimodal-media-button";
const MULTIMODAL_MEDIA_FILE_INPUT_ID = "dpp-multimodal-media-file-input";
const MULTIMODAL_MEDIA_TRAY_ID = "dpp-multimodal-media-tray";
const MULTIMODAL_MEDIA_STATUS_ID = "dpp-multimodal-media-status";
const MULTIMODAL_MEDIA_STYLE_ID = "dpp-multimodal-media-css";
const EXPORT_ACTION_CLASS = "dpp-export-action";
const EXPORT_ACTION_STYLE_ID = "dpp-export-action-css";
const EXPORT_ACTION_TOAST_CLASS = "dpp-export-toast";
const CONTENT_TOAST_CLASS = "dpp-content-toast";
const CONTENT_TOAST_STYLE_ID = "dpp-content-toast-css";
const EXPORT_ACTION_MENU_CLASS = "dpp-export-menu";
const DEEPSEEK_ACTION_CONTROL_SELECTOR = 'button, [role="button"].ds-button';
const EXPORT_ACTION_MOUNT_DEBOUNCE_MS = 250;
const EXPORT_ACTION_RETRY_MS = 250;
const EXPORT_ACTION_RETRY_LIMIT = 20;
const EXPORT_ACTION_TOAST_VISIBLE_MS = 4000;
const PET_HOST_ID = "dpp-pet-host";
const PET_STYLE_ID = "dpp-pet-css";
const TOKEN_SPEED_BOOTSTRAP_RETRY_MS = 250;
const TOKEN_SPEED_BOOTSTRAP_RETRY_LIMIT = 40;
const TOKEN_SPEED_MOUNT_DEBOUNCE_MS = 500;
const MULTIMODAL_MEDIA_MOUNT_DEBOUNCE_MS = 250;
const INLINE_AGENT_TRACE_WRITE_DEBOUNCE_MS = 300;
const INLINE_AGENT_STEP_RENDER_MAX_CHARS = 8000;
// The final answer is first-class user-facing content: never folded and
// effectively never truncated (Issue #551 follow-up). The generous residual
// cap only guards the DOM/markdown renderer against pathological outputs.
const INLINE_AGENT_FINAL_RENDER_MAX_CHARS = 100_000;
const CLEANABLE_TEXT_DEEP_SCAN_MAX_CHARS = 120_000;
const CLEANUP_MESSAGE_SCAN_LIMIT = 24;
const THEME_BOOTSTRAP_RETRY_MS = 250;
const THEME_BOOTSTRAP_RETRY_LIMIT = 20;
const PET_IDLE_DELAY_MS = 900;
const PET_SIDE_OFFSET_PX = 24;
const PET_BOTTOM_OFFSET_PX = 92;
const PET_CUSTOM_EDGE_MARGIN_PX = 12;
const PET_HEIGHT_RATIO = 1;
const PET_FEEDBACK_DELAY_MS = 1400;
const PET_SLEEP_DELAY_MS = 12000;
const PET_SPRITE_PATH = "pet/deepseek-whale-pet-states.png";
const DEEPSEEK_POW_WASM_PATH = "deepseek/sha3_wasm_bg.wasm";
const PET_BUBBLE_VISIBLE_MS = 6000;
const PET_BUBBLE_REPEAT_MIN_MS = 8000;
const PET_BUBBLE_REPEAT_MAX_MS = 12000;
const PET_BUBBLE_RECENT_LIMIT = 3;
type ExportResponse =
  ConversationExportResult | { ok: false; exportId?: string; error: string };
interface ResolvedProjectAugmentationContext {
  projectId: string;
  context: string | null;
}

interface ConversationExportFormatOption {
  format: ConversationExportArtifact["format"];
  labelKey: LocaleMessageKey;
  defaultChecked: boolean;
}

const CONVERSATION_EXPORT_FORMAT_OPTIONS: ConversationExportFormatOption[] = [
  {
    format: "html",
    labelKey: "content.export.formatHtml",
    defaultChecked: true,
  },
  {
    format: "markdown",
    labelKey: "content.export.formatMarkdown",
    defaultChecked: false,
  },
  {
    format: "pdf",
    labelKey: "content.export.formatPdf",
    defaultChecked: false,
  },
  {
    format: "image_manifest",
    labelKey: "content.export.formatImageManifest",
    defaultChecked: false,
  },
];

interface ConversationExportScopeOption {
  scope: ConversationExportContentScope;
  labelKey: LocaleMessageKey;
}

const CONVERSATION_EXPORT_SCOPE_OPTIONS: ConversationExportScopeOption[] = [
  { scope: "full", labelKey: "content.export.scopeFull" },
  { scope: "input-output", labelKey: "content.export.scopeInputOutput" },
];

const CONVERSATION_EXPORT_SCOPE_STORAGE_KEY = "dpp:export:content-scope";

function getStoredConversationExportScope(): ConversationExportContentScope {
  const stored = localStorage.getItem(CONVERSATION_EXPORT_SCOPE_STORAGE_KEY);
  return stored === "input-output" ? "input-output" : "full";
}

function storeConversationExportScope(
  scope: ConversationExportContentScope,
): void {
  localStorage.setItem(CONVERSATION_EXPORT_SCOPE_STORAGE_KEY, scope);
}

function getSelectedConversationExportScope(
  menu: HTMLElement,
): ConversationExportContentScope {
  const checked = menu.querySelector<HTMLInputElement>(
    'input[name="contentScope"]:checked',
  );
  return checked?.value === "input-output" ? "input-output" : "full";
}
// These states keep rotating pet lines during long stays; other states speak once on entry.
const PET_BUBBLE_LOOPING_STATES: ReadonlySet<PetState> = new Set<PetState>([
  "idle",
  "thinking",
  "speaking",
  "working",
]);

interface PetDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
}

interface ActiveToolBlockSession {
  id: string;
  url: string;
  chatSessionId: string | null;
  requestId: string | null;
  parentMessageId: number | null;
  content: string;
  executions: ToolExecutionRecord[];
  createdAt: number;
  updatedAt: number;
}

interface PendingStartedToolCall {
  call: ToolCall;
  session: ActiveToolBlockSession;
}

interface PendingMultimodalMedia {
  id: string;
  kind: MultimodalMediaKind;
  file: File;
  name: string;
  mimeType: string;
  sizeBytes: number;
  objectUrl: string | null;
  routeKey: string;
  createdAt: number;
}

let toolExecutions: ToolExecutionRecord[] = [];
let toolBlockEl: HTMLElement | null = null;
let activeToolBlockSessionId: string | null = null;
let activeStreamingToolCount = 0;
const activeToolBlockSessions = new Map<string, ActiveToolBlockSession>();
const pendingExternalToolPayloadWrites = new Map<string, Promise<void>>();
const activeToolAuthorizations = new Map<
  string,
  ToolAuthorizationGrantSummary
>();
const toolAuthorizationRequestAliases = new Map<string, string>();
const inlineAgentAuthorizationRequestKeys = new Map<string, string>();
const activeToolAuthorizationRequestMetadata = new Map<
  string,
  {
    activeLocalSkillDir?: string;
  }
>();
const regenerateAuthorizationScopes = createRegenerateAuthorizationScopeStore();
const pendingToolAuthorizationCorrelations =
  new PendingAuthorizationCorrelations();
const pendingToolExecutionTasksByRequest = new Map<
  string,
  Set<Promise<ToolCardResult>>
>();
const pendingStartedToolCallsByRequest =
  new PendingRequestRegistry<PendingStartedToolCall>();
let responseGeneration = 0;
let tokenSpeedEl: HTMLElement | null = null;
let tokenSpeedBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let tokenSpeedBootstrapAttempts = 0;
let tokenSpeedMountTimer: ReturnType<typeof setTimeout> | null = null;
let lastTokenSpeedProgress: ResponseTokenSpeedPayload =
  createIdleTokenSpeedProgress();
let tokenSpeedRouteKey = "";
const usageProgressWrites = createUsageProgressWriteCoordinator();
let multimodalMediaMountTimer: ReturnType<typeof setTimeout> | null = null;
let multimodalMediaButtonEl: HTMLButtonElement | null = null;
let multimodalMediaFileInputEl: HTMLInputElement | null = null;
let multimodalMediaTrayEl: HTMLElement | null = null;
let multimodalMediaStatusEl: HTMLElement | null = null;
let multimodalMediaBusy = false;
let multimodalMediaInputEnabled = false;
const pendingMultimodalMedia = new Map<string, PendingMultimodalMedia>();
let toolBlockRouteKey = "";
let exportActionMountTimer: ReturnType<typeof setTimeout> | null = null;
let exportActionRetryTimer: ReturnType<typeof setTimeout> | null = null;
let exportActionRetryAttempts = 0;
let activeConversationExportId: string | null = null;
let exportActionToastTimer: ReturnType<typeof setTimeout> | null = null;
let exportActionMenuEl: HTMLElement | null = null;
let exportActionMenuButton: HTMLButtonElement | null = null;
let exportActionMenuSessionId: string | null = null;
let historyOrganizerController: HistoryOrganizerController | null = null;
let projectSidebarOrganizerController: ProjectSidebarOrganizerController | null =
  null;
const restoredToolRecords = new Map<string, ToolCallRestoreRecord>();
const pendingRestoredToolRecordIds = new Set<string>();
let restoredRenderTimer: ReturnType<typeof setTimeout> | null = null;
let restoredRenderAttempts = 0;
const pendingToolExecutionTasks = new Set<Promise<ToolCardResult>>();
let themeObserver: MutationObserver | null = null;
let themeTreeObserver: MutationObserver | null = null;
let themeMediaQuery: MediaQueryList | null = null;
let themeMediaListener: ((event: MediaQueryListEvent) => void) | null = null;
let themeSyncTimer: ReturnType<typeof setTimeout> | null = null;
let themeBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let themeBootstrapAttempts = 0;
let currentDeepSeekTheme: DeepSeekTheme | null = null;
let currentPetConfig: PetConfig | null = null;
let petHostEl: HTMLElement | null = null;
let petIdleTimer: ReturnType<typeof setTimeout> | null = null;
let petSleepTimer: ReturnType<typeof setTimeout> | null = null;
let petDragState: PetDragState | null = null;
let petResizeListenerInstalled = false;
let petBubbleEl: HTMLElement | null = null;
let petBubbleTextEl: HTMLElement | null = null;
let petBubbleHideTimer: ReturnType<typeof setTimeout> | null = null;
let petBubbleRepeatTimer: ReturnType<typeof setTimeout> | null = null;
let petBubbleState: PetState | null = null;
const petRecentLines: string[] = [];
let inlineAgentContainer: HTMLElement | null = null;
let inlineAgentCurrentStep: HTMLElement | null = null;
let inlineAgentLoopId: string | null = null;
let inlineAgentContainerObserver: MutationObserver | null = null;
// H3：RESPONSE_COMPLETE / EXTRACT_MEMORY 按会话+请求幂等去重，避免同一完成事件在
// 续轮/重发（completion、editMessage 反复）链路里被反复处理、反复发记忆提取。
const memoryExtractSentKeys = new Set<string>();
const MEMORY_EXTRACT_SENT_KEY_MAX = 256;
let renderedToolCallCleanerFrame: number | null = null;
let activeInlineAgentTrace: InlineAgentTraceRecord | null = null;
let inlineAgentTraceWriteTimer: ReturnType<typeof setTimeout> | null = null;
let inlineAgentStreamRenderFrame: number | null = null;
let pendingInlineAgentStreamChunk: InlineAgentStreamChunkMsg | null = null;
/** Reasoning deltas per step that arrived before the step's narration mounted. */
const pendingAgentReasoningByStep = new Map<number, string>();
/**
 * Current-turn-only backend authority. It is never persisted: web sessions
 * delegate their completed final response to DeepSeek's real history renderer,
 * while official-API sessions keep the extension-owned narration surface.
 */
let activeAgentModelBackend: InlineAgentModelBackend | null = null;
const restoredInlineAgentTraces = new Map<string, InlineAgentTraceRecord>();
const pendingRestoredInlineAgentTraceIds = new Set<string>();
let restoredInlineAgentRenderTimer: ReturnType<typeof setTimeout> | null = null;
let restoredInlineAgentRenderAttempts = 0;
let currentMemories: Memory[] = [];
let currentSkills: Skill[] = [];
let currentActivePreset: SystemPromptPreset | null = null;
let currentModelType: ModelType = null;
let currentPromptSettings: PromptInjectionSettings =
  DEFAULT_PROMPT_INJECTION_SETTINGS;
let currentSkillAutoActivation: SkillAutoActivationSettings =
  DEFAULT_SKILL_AUTO_ACTIVATION_SETTINGS;
let currentContentLocale: SupportedLocale = DEFAULT_LOCALE;
let currentContentTranslator = createTranslator(DEFAULT_LOCALE);
let currentToolDescriptors: ToolDescriptor[] = [];
const toolDescriptorSyncGate = createLatestSyncGate();
const TOOL_DESCRIPTOR_RETRY_BASE_MS = 2_000;
const TOOL_DESCRIPTOR_RETRY_MAX_MS = 30_000;
const TOOL_DESCRIPTOR_RETRY_MAX_ATTEMPTS = 6;
const RUNTIME_RECEIVER_RETRY_BASE_MS = 300;
const RUNTIME_RECEIVER_RETRY_MAX_MS = 1_200;
const RUNTIME_RECEIVER_RETRY_MAX_ATTEMPTS = 4;
let toolDescriptorRetryTimer: number | null = null;
let toolDescriptorRetryAttempts = 0;
let currentRequestMessageCount = 0;
// R2-F3: Distinguish user-initiated aborts (stop button, superseding new turn)
// from system-level aborts (page unload, SW teardown) so the DS-web StreamFn
// can decide whether a truncated stream should nudge to continue. System aborts
// leave signal.reason undefined; user aborts carry this AbortError.
const AGENT_USER_ABORT_REASON = new DOMException('Inline agent aborted by user or superseded by a new turn.', 'AbortError');
let activeAgentAbort: AbortController | null = null;
let agentRunningToolCount = 0;
let agentConsoleStartedAt = 0;
let agentConsoleElapsedSeconds = 0;
let agentConsoleTimer: ReturnType<typeof setInterval> | null = null;
/** 输入框常驻状态条（loop 运行时显示，始终在用户视口内） */
let agentStatusBarEl: HTMLElement | null = null;
let agentStatusBarRemoveTimer: ReturnType<typeof setTimeout> | null = null;
let agentStatusBarCurrentTool: string | null = null;
let agentStatusBarCurrentStep = 0;
const pendingInlineAgentLoopTasks = new Set<Promise<void>>();
let toolOpenTagRe = buildToolOpenTagRegex(currentToolDescriptors);
let toolMarkerRe = buildToolMarkerRegex(currentToolDescriptors);
let extensionContextValid = true;
let contentDocumentLifecycle: ContentDocumentLifecycle | null = null;
let mainWorldBridgeController: IsolatedBridgeController | null = null;
let runtimeStateCapabilityScope: ContentResourceScope | null = null;
let remoteAgentCapabilityScope: ContentResourceScope | null = null;
let tokenSpeedCapabilityScope: ContentResourceScope | null = null;
let toolCapabilityScope: ContentResourceScope | null = null;
let toolCapabilityEpoch = 0;
const pendingToolPersistenceOperations = new Set<Promise<unknown>>();
let inlineAgentCapabilityScope: ContentResourceScope | null = null;
let inlineAgentCapabilityEpoch = 0;
const pendingInlineAgentPersistenceOperations = new Set<Promise<unknown>>();
let multimodalCapabilityScope: ContentResourceScope | null = null;
let debugTelemetryCapabilityScope: ContentResourceScope | null = null;
let exportCapabilityScope: ContentResourceScope | null = null;
let exportDownloadManager: BrowserDownloadManager | null = null;
let backgroundCapabilityScope: ContentResourceScope | null = null;
let petCapabilityScope: ContentResourceScope | null = null;

function contentT(key: LocaleMessageKey, params?: MessageParams): string {
  return currentContentTranslator.t(key, params);
}

async function refreshContentLocale(): Promise<void> {
  const resolved = await getResolvedLocaleState();
  currentContentLocale = resolved.locale;
  currentContentTranslator = createTranslator(resolved.locale);
  refreshLocalizedContentSurfaces();
}

function refreshLocalizedContentSurfaces(): void {
  if (exportCapabilityScope?.active) {
    setConversationExportButtonsStatus(
      activeConversationExportId ? "running" : "idle",
    );
  }
  if (
    exportCapabilityScope?.active &&
    exportActionMenuEl &&
    exportActionMenuButton
  ) {
    showConversationExportMenu(exportActionMenuButton);
  }
  historyOrganizerController?.refreshLabels();
  projectSidebarOrganizerController?.refreshLabels();
  if (tokenSpeedCapabilityScope?.active)
    renderTokenSpeedIndicator(lastTokenSpeedProgress);
  if (toolCapabilityScope?.active) {
    renderActiveToolBlockForCurrentRoute();
    scheduleRenderRestoredToolBlocks();
  }
  if (inlineAgentCapabilityScope?.active)
    scheduleRenderRestoredInlineAgentTraces();
  if (multimodalCapabilityScope?.active) renderMultimodalMediaTray();
}

function getAgentRendererLabels() {
  return {
    starting: contentT("content.agent.starting"),
    stop: contentT("content.agent.stop"),
    running: (stepNumber: number, toolCount: number, elapsedSeconds: number) =>
      contentT("content.agent.running", {
        step: stepNumber + 1,
        tools: toolCount,
        seconds: elapsedSeconds,
      }),
    toolOk: contentT("content.toolBlock.summaries.executed"),
    toolError: contentT("content.toolBlock.summaries.failed"),
    consoleComplete: (
      totalSteps: number,
      totalTools: number,
      elapsedSeconds: number,
    ) =>
      contentT("content.agent.consoleComplete", {
        steps: totalSteps,
        tools: totalTools,
        seconds: elapsedSeconds,
      }),
    consolePaused: (
      totalSteps: number,
      totalTools: number,
      elapsedSeconds: number,
    ) =>
      contentT("content.agent.consolePaused", {
        steps: totalSteps,
        tools: totalTools,
        seconds: elapsedSeconds,
      }),
    consoleError: (
      totalSteps: number,
      totalTools: number,
      elapsedSeconds: number,
    ) =>
      contentT("content.agent.consoleError", {
        steps: totalSteps,
        tools: totalTools,
        seconds: elapsedSeconds,
      }),
    toolGroup: (count: number) =>
      contentT("content.agent.toolGroup", { count }),
    reasoningStep: (stepNumber: number) =>
      contentT("content.agent.reasoningStep", { step: stepNumber + 1 }),
    reasoningNotPersisted: contentT("content.agent.reasoningNotPersisted"),
    codeRun: contentT("content.agent.codeRun"),
    codeRunning: contentT("content.agent.codeRunning"),
    codeRunFailed: contentT("content.agent.codeRunFailed"),
  };
}

/**
 * Agent console timing (Issue #551): a low-frequency 1s tick drives the
 * elapsed-seconds counter in the console header. Explicit start/stop
 * lifecycle, always released through the capability scope.
 */
function startAgentConsoleTimer(): void {
  stopAgentConsoleTimer();
  agentConsoleStartedAt = Date.now();
  agentConsoleElapsedSeconds = 0;
  if (!inlineAgentContainer || !inlineAgentCapabilityScope) return;
  agentConsoleTimer = inlineAgentCapabilityScope.setInterval(() => {
    agentConsoleElapsedSeconds = getAgentConsoleElapsedSeconds();
    renderRunningAgentConsoleHeader();
  }, 1000);
}

function stopAgentConsoleTimer(): void {
  if (agentConsoleTimer !== null) {
    inlineAgentCapabilityScope?.clearInterval(agentConsoleTimer);
    agentConsoleTimer = null;
  }
}

function getAgentConsoleElapsedSeconds(): number {
  return agentConsoleStartedAt > 0
    ? Math.floor((Date.now() - agentConsoleStartedAt) / 1000)
    : 0;
}

function renderRunningAgentConsoleHeader(): void {
  const container = inlineAgentContainer;
  if (!container) return;
  updateAgentConsoleHeader(
    container,
    {
      phase: "running",
      stepNumber: inlineAgentCurrentStep
        ? Number(inlineAgentCurrentStep.getAttribute("data-step-index") ?? 0)
        : 0,
      toolCount: agentRunningToolCount,
      totalSteps: 0,
      totalTools: 0,
      elapsedSeconds: agentConsoleElapsedSeconds,
    },
    getAgentRendererLabels(),
  );
}

function renderTerminalAgentConsoleHeader(
  container: HTMLElement,
  phase: Exclude<AgentConsolePhase, "starting" | "running">,
  totalSteps: number,
  totalTools: number,
  labelOverride?: string,
  elapsedSeconds: number = getAgentConsoleElapsedSeconds(),
): void {
  updateAgentConsoleHeader(
    container,
    {
      phase,
      stepNumber: 0,
      toolCount: agentRunningToolCount,
      totalSteps,
      totalTools,
      elapsedSeconds,
      labelOverride,
    },
    getAgentRendererLabels(),
  );
}

function getHistoryOrganizerLabels() {
  return {
    enhancedSearchTitle: contentT(
      "content.historyOrganizer.enhancedSearchTitle",
    ),
    tagFilterLabel: contentT("content.historyOrganizer.tagFilterLabel"),
    tagPlaceholder: contentT("content.historyOrganizer.tagPlaceholder"),
    currentTagsLabel: contentT("content.historyOrganizer.currentTagsLabel"),
    currentTagsPlaceholder: contentT(
      "content.historyOrganizer.currentTagsPlaceholder",
    ),
    emptySearchStatus: contentT("content.historyOrganizer.emptySearchStatus"),
    visibleStatus: (visibleCount: number, totalCount: number) =>
      contentT("content.historyOrganizer.visibleStatus", {
        visible: visibleCount,
        total: totalCount,
      }),
    storageError: (action: "load" | "save", message: string) =>
      contentT(
        action === "load"
          ? "content.historyOrganizer.loadError"
          : "content.historyOrganizer.saveError",
        { message },
      ),
  };
}

function getProjectSidebarOrganizerLabels() {
  return {
    title: contentT("content.projectSidebar.title"),
    empty: contentT("content.projectSidebar.empty"),
    expandProject: (name: string) =>
      contentT("content.projectSidebar.expandProject", { name }),
    collapseProject: (name: string) =>
      contentT("content.projectSidebar.collapseProject", { name }),
    showMore: contentT("content.projectSidebar.showMore"),
    showLess: contentT("content.projectSidebar.showLess"),
    moveCurrentToProject: (name: string) =>
      contentT("content.projectSidebar.moveCurrentToProject", { name }),
    removeCurrentFromProject: (name: string) =>
      contentT("content.projectSidebar.removeCurrentFromProject", { name }),
    joinProject: contentT("content.projectSidebar.joinProject"),
    joinProjectNamed: (name: string) =>
      contentT("content.projectSidebar.joinProjectNamed", { name }),
    moveToProjectNamed: (name: string) =>
      contentT("content.projectSidebar.moveToProjectNamed", { name }),
    currentProjectNamed: (name: string) =>
      contentT("content.projectSidebar.currentProjectNamed", { name }),
    removeFromProjectNamed: (name: string) =>
      contentT("content.projectSidebar.removeFromProjectNamed", { name }),
    conversationActions: contentT("content.projectSidebar.conversationActions"),
    newConversationInProject: (name: string) =>
      contentT("content.projectSidebar.newConversationInProject", { name }),
    useNextConversation: (name: string) =>
      contentT("content.projectSidebar.useNextConversation", { name }),
    cancelNextConversation: (name: string) =>
      contentT("content.projectSidebar.cancelNextConversation", { name }),
    pendingNextConversation: contentT(
      "content.projectSidebar.pendingNextConversation",
    ),
    untitledConversation: contentT("content.conversation.untitled"),
    operationFailed: (message: string) =>
      contentT("content.projectSidebar.operationFailed", { message }),
    age: (timestamp: number) => formatContentAge(timestamp),
  };
}

function formatContentAge(timestamp: number): string {
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return contentT("content.projectSidebar.age.justNow");
  if (mins < 60)
    return contentT("content.projectSidebar.age.minutesAgo", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return contentT("content.projectSidebar.age.hoursAgo", { count: hours });
  return contentT("content.projectSidebar.age.daysAgo", {
    count: Math.floor(hours / 24),
  });
}

export default defineContentScript({
  matches: ["*://chat.deepseek.com/*"],
  runAt: "document_start",
  async main() {
    extensionContextValid = true;
    // 恢复 native-history reload 前保存的用户状态（滚动位置、输入草稿）
    restoreAfterNativeHistoryReload();
    const controllers = createContentCapabilityControllers();
    const lifecycle = await replaceContentDocumentLifecycle({
      capabilities: controllers,
      onError: reportContentLifecycleError,
    });
    if (!extensionContextValid) {
      await lifecycle.dispose("extension-invalidated");
      return;
    }
    contentDocumentLifecycle = lifecycle;
  },
});

function createContentCapabilityControllers(): readonly ContentCapabilityController[] {
  const chatController = createContentChatController({
    dispatch: dispatchMainWorldMessage,
  });
  const mutationHub = createContentMutationHub({
    reportError: reportContentLifecycleError,
  });
  const bridgeController = createIsolatedBridgeController({
    handleAugmentRequestBody,
    handleMainWorldMessage: chatController.handle,
    syncRuntimeState: syncCurrentRuntimeStateToMainWorld,
    disconnectRuntimeState: disconnectMainWorldRuntimeState,
    reportError(message, error) {
      if (error === undefined) console.error(message);
      else console.error(message, error);
    },
  });
  mainWorldBridgeController = bridgeController;

  return [
    createRuntimeStateCapability(),
    // Start transport before DOM capabilities; chat ingress starts last so reverse
    // teardown gates new dispatch before aborting work and closing authorizations.
    bridgeController,
    createDomCapability("theme", startThemeCapability, stopThemeCapability),
    createDomCapability(
      "mutation-hub",
      (scope) => mutationHub.start(scope),
      () => mutationHub.stop(),
    ),
    createDomCapability(
      "token-speed",
      (scope) => startTokenSpeedCapability(scope, mutationHub),
      stopTokenSpeedCapability,
    ),
    createDomCapability(
      "tool",
      (scope) => startToolCapability(scope, mutationHub),
      stopToolCapability,
    ),
    createDomCapability(
      "inline-agent",
      (scope) => startInlineAgentCapability(scope, mutationHub),
      stopInlineAgentCapability,
    ),
    createDomCapability(
      "multimodal",
      (scope) => startMultimodalCapability(scope, mutationHub),
      stopMultimodalCapability,
    ),
    createDomCapability(
      "export",
      (scope) => startExportCapability(scope, mutationHub),
      stopExportCapability,
    ),
    createDomCapability(
      "history",
      startHistoryCapability,
      stopHistoryCapability,
    ),
    createDomCapability(
      "project",
      startProjectCapability,
      stopProjectCapability,
    ),
    createDomCapability(
      "background",
      (scope) => startBackgroundCapability(scope, mutationHub),
      stopBackgroundCapability,
    ),
    createDomCapability("pet", startPetCapability, stopPetCapability),
    createRemoteAgentCapability(),
    createDebugTelemetryCapability(),
    chatController,
  ];
}

function createRuntimeStateCapability(): ContentCapabilityController {
  return {
    id: "runtime-state",
    async start(scope) {
      runtimeStateCapabilityScope = scope;
      const isCurrent = () =>
        runtimeStateCapabilityScope === scope && scope.active;
      registerDefaultToolResultRenderers();
      await refreshContentLocale();
      if (!isCurrent()) return;
      scope.addCleanup(
        "listener",
        watchLocalePreference(() => {
          if (!isCurrent()) return;
          void refreshContentLocale()
            .then(() => {
              if (isCurrent())
                return loadAndSyncRuntimeState(undefined, isCurrent);
            })
            .catch((error) =>
              console.error(
                "[DeepSeek++] content locale refresh failed",
                error,
              ),
            );
        }),
      );
      scope.addCleanup("listener", installExtensionInvalidationGuards());
      scope.addCleanup(
        "listener",
        addRuntimeMessageListener(handleContentRuntimeMessage),
      );
      void loadAndSyncRuntimeState(undefined, isCurrent);
    },
    stop() {
      runtimeStateCapabilityScope = null;
      clearToolDescriptorRetry();
    },
  };
}

function createDomCapability(
  id: string,
  start: (scope: ContentResourceScope) => void | Promise<void>,
  stop: () => void | Promise<void>,
): ContentCapabilityController {
  return createDomCapabilityController({
    id,
    start,
    stop,
    reportError: reportContentLifecycleError,
  });
}

function reportContentLifecycleError(error: unknown): void {
  console.error("[DeepSeek++] content lifecycle failed", error);
}

const contentPersistenceTracker = createContentPersistenceTracker({
  isExtensionInvalidated: isExtensionInvalidatedError,
  invalidateExtension: () => invalidateExtensionContext(),
  reportFailure(label, error) {
    console.error(`[DeepSeek++] ${label} persistence failed`, error);
  },
});

function observeReportedPersistence(operation: Promise<unknown>): void {
  // The persistence boundary logged the rejection; this terminal observer prevents
  // a duplicate unhandled-rejection report for intentionally fire-and-observe writes.
  void operation.catch(() => undefined);
}

function isToolEpochActive(
  scope: ContentResourceScope,
  epoch: number,
): boolean {
  return (
    toolCapabilityScope === scope &&
    toolCapabilityEpoch === epoch &&
    scope.active
  );
}

function isInlineAgentEpochActive(
  scope: ContentResourceScope,
  epoch: number,
): boolean {
  return (
    inlineAgentCapabilityScope === scope &&
    inlineAgentCapabilityEpoch === epoch &&
    scope.active
  );
}

function startThemeCapability(): void {
  startDeepSeekThemeSync();
}

function stopThemeCapability(): void {
  stopDeepSeekThemeSync();
  document.getElementById("dpp-injected-theme-css")?.remove();
  document.body.classList.remove("dpp-theme-dark", "dpp-theme-light");
}

function startTokenSpeedCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  tokenSpeedCapabilityScope = scope;
  startTokenSpeedIndicatorBootstrap();
  startTokenSpeedIndicatorMountSubscription(scope, mutationHub);
  tokenSpeedRouteKey = getTokenSpeedRouteKey();
}

function stopTokenSpeedCapability(): void {
  tokenSpeedCapabilityScope = null;
  stopTokenSpeedIndicatorBootstrap();
  stopTokenSpeedIndicatorMountSubscription();
  tokenSpeedRouteKey = "";
  removeTokenSpeedIndicator();
  document.getElementById(TOKEN_SPEED_STYLE_ID)?.remove();
}

function startToolCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  toolCapabilityScope = scope;
  const epoch = ++toolCapabilityEpoch;
  toolBlockRouteKey = getTokenSpeedRouteKey();
  startRenderedToolCallCleaner(scope, mutationHub);
  observeReportedPersistence(restorePersistedToolBlocks(scope, epoch));
}

async function stopToolCapability(): Promise<void> {
  toolCapabilityScope = null;
  toolCapabilityEpoch += 1;
  toolBlockRouteKey = "";
  stopRenderedToolCallCleaner();
  finishActivePermissionRequest(false);
  if (restoredRenderTimer) {
    clearTimeout(restoredRenderTimer);
    restoredRenderTimer = null;
  }
  const errors: unknown[] = [];
  pendingToolAuthorizationCorrelations.terminateAll();
  try {
    await closeAllContentToolAuthorizations();
  } catch (error) {
    errors.push(error);
  }
  try {
    await finalizePendingToolStarts(
      pendingStartedToolCallsByRequest.drainAll(),
    );
  } catch (error) {
    errors.push(error);
  }
  while (pendingToolExecutionTasks.size > 0) {
    await Promise.allSettled([...pendingToolExecutionTasks]);
  }
  while (pendingToolPersistenceOperations.size > 0) {
    await Promise.allSettled([...pendingToolPersistenceOperations]);
  }
  activeStreamingToolCount = 0;
  activeToolBlockSessionId = null;
  toolExecutions = [];
  toolBlockEl = null;
  activeToolBlockSessions.clear();
  restoredToolRecords.clear();
  pendingRestoredToolRecordIds.clear();
  activeToolAuthorizations.clear();
  toolAuthorizationRequestAliases.clear();
  inlineAgentAuthorizationRequestKeys.clear();
  activeToolAuthorizationRequestMetadata.clear();
  regenerateAuthorizationScopes.clear();
  pendingExternalToolPayloadWrites.clear();
  pendingToolExecutionTasksByRequest.clear();
  restoredRenderAttempts = 0;
  document
    .querySelectorAll(".dpp-tool-block, .dpp-artifact-results")
    .forEach((node) => node.remove());
  document.getElementById(PERMISSION_BANNER_STYLE_ID)?.remove();
  document.getElementById(TOOL_BLOCK_STYLE_ID)?.remove();
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Content tool capability teardown failed.",
    );
  }
}

function startInlineAgentCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  inlineAgentCapabilityScope = scope;
  const epoch = ++inlineAgentCapabilityEpoch;
  startInlineAgentContinuationMessageHider(scope, mutationHub);
  observeReportedPersistence(restorePersistedInlineAgentTraces(scope, epoch));
}

async function stopInlineAgentCapability(): Promise<void> {
  inlineAgentCapabilityScope = null;
  inlineAgentCapabilityEpoch += 1;
  stopInlineAgentContinuationMessageHider();
  if (activeAgentAbort || inlineAgentContainer) stopInlineAgent();
  while (pendingInlineAgentLoopTasks.size > 0) {
    await Promise.allSettled([...pendingInlineAgentLoopTasks]);
  }
  teardownInlineAgentPanel();
  if (restoredInlineAgentRenderTimer) {
    clearTimeout(restoredInlineAgentRenderTimer);
    restoredInlineAgentRenderTimer = null;
  }
  if (inlineAgentTraceWriteTimer) {
    clearTimeout(inlineAgentTraceWriteTimer);
    inlineAgentTraceWriteTimer = null;
  }
  cancelPendingInlineAgentStreamRender();
  while (pendingInlineAgentPersistenceOperations.size > 0) {
    await Promise.allSettled([...pendingInlineAgentPersistenceOperations]);
  }
  responseGeneration += 1;
  restoredInlineAgentTraces.clear();
  pendingRestoredInlineAgentTraceIds.clear();
  restoredInlineAgentRenderAttempts = 0;
  document
    .querySelectorAll(".dpp-agent-container")
    .forEach((node) => node.remove());
  stopAgentConsoleTimer();
  removeInlineAgentStyles();
  if (contentToastTimer) {
    clearTimeout(contentToastTimer);
    contentToastTimer = null;
  }
  document
    .querySelectorAll(`.${CONTENT_TOAST_CLASS}`)
    .forEach((node) => node.remove());
  document.getElementById(CONTENT_TOAST_STYLE_ID)?.remove();
}

function startMultimodalCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  multimodalCapabilityScope = scope;
  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) =>
        multimodalCapabilityScope === scope &&
        scope.active &&
        mutations.some(mutationMayAffectPromptControls),
      handle: scheduleMultimodalMediaMount,
    }),
  );
  void refreshMultimodalMediaInputAvailability(
    () => multimodalCapabilityScope === scope && scope.active,
  );
}

function stopMultimodalCapability(): void {
  multimodalCapabilityScope = null;
  stopMultimodalMediaInput();
  multimodalMediaInputEnabled = false;
}

function startExportCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  exportCapabilityScope = scope;
  exportDownloadManager?.stop();
  exportDownloadManager = createBrowserDownloadManager();
  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) =>
        exportCapabilityScope === scope &&
        scope.active &&
        mutations.some(mutationMayAffectConversationExportActions),
      handle: scheduleConversationExportActionMount,
    }),
  );
  startConversationExportActionInjector();
}

function stopExportCapability(): void {
  exportCapabilityScope = null;
  exportDownloadManager?.stop();
  exportDownloadManager = null;
  stopConversationExportActionInjector();
}

function startHistoryCapability(): void {
  historyOrganizerController = startDeepSeekHistoryOrganizer(
    getHistoryOrganizerLabels,
  );
}

function stopHistoryCapability(): void {
  historyOrganizerController?.stop();
  historyOrganizerController = null;
}

function startProjectCapability(): void {
  projectSidebarOrganizerController = startDeepSeekProjectSidebarOrganizer(
    getProjectSidebarOrganizerLabels,
  );
}

function stopProjectCapability(): void {
  projectSidebarOrganizerController?.stop();
  projectSidebarOrganizerController = null;
}

function startBackgroundCapability(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
): void {
  backgroundCapabilityScope = scope;
  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) =>
        backgroundCapabilityScope === scope &&
        scope.active &&
        document.body.classList.contains("dpp-bg-active") &&
        mutations.some((mutation) => mutation.type === "childList"),
      handle: patchContainerBackgrounds,
    }),
  );
  void sendRuntimeMessage<BackgroundConfig | null>({
    type: "GET_BACKGROUND",
  }).then((config) => {
    if (backgroundCapabilityScope === scope && scope.active)
      applyBackground(config ?? null);
  });
}

function stopBackgroundCapability(): void {
  backgroundCapabilityScope = null;
  removeBackground();
}

function startPetCapability(scope: ContentResourceScope): void {
  petCapabilityScope = scope;
  void sendRuntimeMessage<PetConfig | null>({ type: "GET_PET" }).then(
    (config) => {
      if (petCapabilityScope === scope && scope.active)
        applyPetConfig(config ?? null);
    },
  );
}

function stopPetCapability(): void {
  petCapabilityScope = null;
  removePet();
  currentPetConfig = null;
  document.getElementById(PET_STYLE_ID)?.remove();
}

async function dispatchMainWorldMessage(
  data: Record<string, unknown>,
): Promise<void> {
  try {
    switch (data.type) {
      case "TOOL_CALL_STARTED": {
        showPendingToolExecution(data.data as ToolCall);
        break;
      }
      case "TOOL_CALL": {
        const call = ensureToolCallId(data.data as ToolCall);
        setPetState("working");
        void runToolExecution(call);
        break;
      }
      case "TOOL_CALL_CHUNK": {
        await appendExternalToolPayloadChunk(data.data as ToolCallPayloadChunk);
        break;
      }
      case "RESTORE_TOOL_CALLS": {
        rememberRestoredToolRecords(data.records as ToolCallRestoreRecord[]);
        break;
      }
      case "MEMORIES_USED": {
        await sendRuntimeMessage({
          type: "TOUCH_MEMORIES",
          payload: { ids: data.ids as number[] },
        });
        break;
      }
      case "HEADERS_CAPTURED": {
        await persistDeepSeekClientHeaders(
          normalizeCapturedClientHeaders(data.headers),
        );
        break;
      }
      case "NAVIGATION_CHANGED": {
        handleContentNavigation();
        break;
      }
      case "RESPONSE_COMPLETE": {
        const complete = normalizeResponseCompletePayload(
          data.payload,
          data.text,
        );
        rememberRegenerateAuthorizationScope(complete);
        const generation = ++responseGeneration;
        activeStreamingToolCount = 0;
        await waitForPendingToolExecutions(complete.requestId);
        await finalizeInterruptedToolStarts(complete.requestId);
        if (generation !== responseGeneration) break;
        const session = getActiveToolBlockSessionForComplete(complete);
        const completedExecutions = session
          ? [...session.executions]
          : [...toolExecutions];
        // 2026-10-30 真机：DeepSeek 有时发 FINISHED 帧但正文为空、只有思考块
        // （"已思考…让我开始。" 然后 5 分钟不动）。这不是断流也不是正常完成，
        // 用户看到的就是"什么都没发生"。这里识别出来并给一条可见提示 + 诊断记录。
        // 判据读**渲染出来的正文**：payload.text 里带着整段思考，用它判会漏报。
        const domAnswerText = hasAssistantMessage(document)
          ? readLastAssistantAnswerText(document)
          : (complete.text ?? "");
        // 聊天层：模型只给计划、没调工具时自动续一次（等价于用户手打"继续完成"）。
        // 必须在这一层做 —— 此时 agent loop 根本没启动，loop 层的计划型守卫走不到。
        const domAnswerForPlanCheck = hasAssistantMessage(document)
          ? readLastAssistantAnswerText(document)
          : (complete.text ?? "");
        const autoContinueBudgetDecision = decideAutoContinueBudget({
          budget: autoContinueBudget,
          now: Date.now(),
        });
        if (decideChatLayerContinuation({
          answerText: domAnswerForPlanCheck,
          hadToolExecutions: completedExecutions.length > 0,
          alreadyContinued: !autoContinueBudgetDecision.allow,
          enabled: true,
        })) {
          planOnlyContinuedRequestId = complete.requestId ?? "";
          autoContinueBudget = autoContinueBudgetDecision.next;
          diagnosticLogBuffer.record({
            level: "warn",
            source: "chat",
            message: "plan_only_auto_continue",
            details: `len=${domAnswerForPlanCheck.length}`
          });
          showContentToast(contentT("content.agent.planOnlyContinue"), "info");
          const insertedPlanContinuation = insertTextIntoPromptTextarea(
            contentT("content.agent.planOnlyContinuePrompt"),
          );
          if (insertedPlanContinuation.ok) submitComposerFromContent();
        }

        const emptyAnswerVerdict = classifyEmptyAnswer({
          answerText: domAnswerText,
          hasToolExecutions: completedExecutions.length > 0,
        });
        if (shouldWarnEmptyAnswer(emptyAnswerVerdict)) {
          diagnosticLogBuffer.record({
            level: "warn",
            source: "chat",
            message: "empty_answer",
            details: `verdict=${emptyAnswerVerdict} textLen=${(complete.text ?? "").length} tools=${completedExecutions.length}`,
          });
          showContentToast(contentT("content.agent.emptyAnswer"), "warning");
        }

        // 2026-10-30 真机：页面轮次由 content script 驱动（request-interceptor），
        // 服务端以 INCOMPLETE 收尾时正文常为 0 字 ⇒ 用户看到"第一步就停"。
        // 空回答不是"没有答案"，而是"这一轮没产出" ⇒ 自动续一次（与计划型共用上限）。
        const shortAnswerContinuation = isSuspiciouslyShortAnswer({
          answerText: domAnswerText,
          hadToolExecutions: completedExecutions.length > 0,
        });
        if ((emptyAnswerVerdict === "empty" || shortAnswerContinuation || complete.truncated === true) && completedExecutions.length === 0) {
          const requestKey = complete.requestId ?? "";
          if (autoContinueBudgetDecision.allow) {
            autoContinueBudget = autoContinueBudgetDecision.next;
            planOnlyContinuedRequestId = requestKey;
            diagnosticLogBuffer.record({
              level: "warn",
              source: "chat",
              message: "empty_answer_auto_continue",
              details: `verdict=empty truncated=${complete.truncated === true} requestId=${requestKey}`,
            });
            showContentToast(contentT("content.agent.planOnlyContinue"), "info");
            const insertedEmptyContinuation = insertTextIntoPromptTextarea(
              contentT("content.agent.planOnlyContinuePrompt"),
            );
            if (insertedEmptyContinuation.ok) submitComposerFromContent();
          }
        }
        if (session && session.executions.length > 0) {
          await persistToolBlockSession(session, complete.text, complete);
          const renderedBlock =
            (findRestoredToolBlock(session.id) as HTMLElement | null) ??
            toolBlockEl;
          collapseToolBlock(renderedBlock);
          activeToolBlockSessions.delete(session.id);
          if (activeToolBlockSessionId === session.id) {
            activeToolBlockSessionId = null;
            toolExecutions = [];
            toolBlockEl = null;
          }
        } else if (toolExecutions.length > 0) {
          const fallbackSession = getCurrentRouteActiveToolBlockSession();
          if (fallbackSession)
            await persistToolBlockSession(
              fallbackSession,
              complete.text,
              complete,
            );
          collapseToolBlock(toolBlockEl);
          toolExecutions = [];
          toolBlockEl = null;
        }
        startInlineAgentIfNeeded(complete, completedExecutions).catch((err) => {
          console.error('[DPP] 续轮启动失败', err);
        });
        schedulePetIdle();

        // 自动提取记忆：对话完成后发送消息给 background
        console.log('[memory-extractor] RESPONSE_COMPLETE 触发', {
          chatSessionId: complete.chatSessionId,
          originalPrompt: complete.originalPrompt?.slice(0, 50),
          text: complete.text?.slice(0, 50),
        });
        if (complete.chatSessionId && complete.originalPrompt) {
          // 同一 chatSessionId+requestId（无 requestId 时退化为会话+首句）只发一次。
          const extractKey = complete.requestId
            ? `${complete.chatSessionId}::${complete.requestId}`
            : `${complete.chatSessionId}::${complete.originalPrompt.slice(0, 80)}`;
          if (memoryExtractSentKeys.has(extractKey)) {
            console.log('[memory-extractor] 已提取过，跳过重复完成事件', {
              chatSessionId: complete.chatSessionId,
              requestId: complete.requestId,
            });
          } else {
            memoryExtractSentKeys.add(extractKey);
            if (memoryExtractSentKeys.size > MEMORY_EXTRACT_SENT_KEY_MAX) {
              memoryExtractSentKeys.clear();
              memoryExtractSentKeys.add(extractKey);
            }
            console.log('[memory-extractor] 发送 EXTRACT_MEMORY_FROM_CONVERSATION 消息');
            void sendRuntimeMessage({
              type: "EXTRACT_MEMORY_FROM_CONVERSATION",
              payload: {
                chatSessionId: complete.chatSessionId,
                userMessage: complete.originalPrompt,
                assistantMessage: complete.text,
              },
            }).catch((error) => {
              console.error('[memory-extractor] 发送消息失败', error);
            });
          }
        } else {
          console.log('[memory-extractor] 跳过：chatSessionId 或 originalPrompt 为空');
        }

        break;
      }
      case "REQUEST_TERMINAL": {
        const requestId = (data.payload as { requestId?: unknown } | undefined)
          ?.requestId;
        if (typeof requestId !== "string") break;
        if (
          activeToolAuthorizations.has(requestId) ||
          toolAuthorizationRequestAliases.has(requestId)
        ) {
          pendingToolAuthorizationCorrelations.terminate(requestId);
          await waitForPendingToolExecutions(requestId);
          await finalizeInterruptedToolStarts(requestId);
          await closeContentToolAuthorization(requestId);
        } else {
          pendingToolAuthorizationCorrelations.terminate(requestId);
        }
        break;
      }
      case "RESPONSE_TOKEN_SPEED": {
        const progress = normalizeResponseTokenSpeedPayload(data.payload);
        if (progress) {
          updateTokenSpeedIndicator(progress);
          updatePetFromTokenSpeed(progress);
        }
        break;
      }
    }
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    else
      console.error("[DeepSeek++] main-world message handling failed", error);
  }
}

// Console log continuity: the buffer survives the one reload the inline-agent
// terminal flow performs. It stays inside the isolated world and, when it must
// cross the reload, inside extension-owned storage. chat.deepseek.com page
// scripts can read this origin's localStorage, so nothing may be persisted there.
const CONSOLE_LOG_BUFFER_KEY = 'dpp_console_log_buffer';
const LEGACY_CONSOLE_LOG_STORAGE_KEY = 'dpp_console_log_buffer';
const CONSOLE_LOG_MAX_ENTRIES = 500;
const CONSOLE_LOG_MAX_CHARS = 128_000;
let consoleLogBuffer: string[] = [];
let consoleLogPersistenceWarned = false;

function warnOnceConsoleLogPersistenceFailed(reason: string): void {
  if (consoleLogPersistenceWarned) return;
  consoleLogPersistenceWarned = true;
  console.warn('[DeepSeek++] console log handoff degraded:', reason);
}

function clampConsoleLogBuffer(): void {
  if (consoleLogBuffer.length > CONSOLE_LOG_MAX_ENTRIES) {
    consoleLogBuffer = consoleLogBuffer.slice(-CONSOLE_LOG_MAX_ENTRIES);
  }
  let chars = 0;
  let dropBefore = 0;
  for (let index = consoleLogBuffer.length - 1; index >= 0; index -= 1) {
    chars += consoleLogBuffer[index].length;
    if (chars > CONSOLE_LOG_MAX_CHARS) {
      dropBefore = index + 1;
      break;
    }
  }
  if (dropBefore > 0) consoleLogBuffer = consoleLogBuffer.slice(dropBefore);
}

function persistConsoleLogBufferBeforeReload(): Promise<void> {
  return chrome.storage.local
    .set({ [CONSOLE_LOG_BUFFER_KEY]: consoleLogBuffer })
    .catch((error: unknown) => {
      warnOnceConsoleLogPersistenceFailed(error instanceof Error ? error.message : String(error));
    });
}

function initConsoleLogPersistence(): void {
  // Hook console methods
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalInfo = console.info.bind(console);

  const addEntry = (level: string, args: unknown[]) => {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      consoleLogBuffer.push(`[${new Date().toISOString()}] [${level}] ${msg}`);
      clampConsoleLogBuffer();
    } catch (error) {
      originalWarn(
        '[DeepSeek++] console log capture failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  console.log = (...args) => { addEntry('log', args); originalLog(...args); };
  console.warn = (...args) => { addEntry('warn', args); originalWarn(...args); };
  console.error = (...args) => { addEntry('error', args); originalError(...args); };
  console.info = (...args) => { addEntry('info', args); originalInfo(...args); };

  try {
    localStorage.removeItem(LEGACY_CONSOLE_LOG_STORAGE_KEY);
  } catch (error) {
    warnOnceConsoleLogPersistenceFailed(error instanceof Error ? error.message : String(error));
  }

  // The handoff buffer is single-use: it is consumed by the reload it was written for.
  chrome.storage.local
    .get(CONSOLE_LOG_BUFFER_KEY)
    .then((stored) => {
      const entries = (stored as Record<string, unknown>)[CONSOLE_LOG_BUFFER_KEY];
      if (!Array.isArray(entries)) return undefined;
      consoleLogBuffer = entries.filter((entry): entry is string => typeof entry === 'string');
      clampConsoleLogBuffer();
      if (consoleLogBuffer.length === 0) return chrome.storage.local.remove(CONSOLE_LOG_BUFFER_KEY);
      originalLog('%c--- Restored console logs from previous session ---', 'color: #999; font-style: italic');
      for (const entry of consoleLogBuffer) originalLog(entry);
      originalLog('%c--- End of restored logs ---', 'color: #999; font-style: italic');
      return chrome.storage.local.remove(CONSOLE_LOG_BUFFER_KEY);
    })
    .catch((error: unknown) => {
      warnOnceConsoleLogPersistenceFailed(error instanceof Error ? error.message : String(error));
    });
}

const RELOAD_STATE_KEY = "dpp:native-history-reload-state";

function reloadInlineAgentNativeHistory(): void {
  // P0-1 惰性刷新：先保存用户状态（滚动位置、输入草稿）供刷新后恢复；
  // 再写 pending 标记。页面可见时绝不主动硬刷新，推迟到下次发消息前或切后台。
  try {
    const textarea = getPromptTextarea();
    const state = {
      scrollTop: document.scrollingElement?.scrollTop ?? 0,
      composer: textarea?.value ?? "",
      savedAt: Date.now(),
    };
    sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify(state));
  } catch { /* sessionStorage 不可用时忽略 */ }

  requestNativeHistoryReload({
    storage: sessionStorage,
    isHidden: () => document.hidden,
    reload: () => window.location.reload(),
  });
}

/**
 * reload 后恢复用户状态（滚动位置、输入草稿）。
 * 在 content script 初始化时调用。
 */
function restoreAfterNativeHistoryReload(): void {
  try {
    const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(RELOAD_STATE_KEY);
    const state = JSON.parse(raw) as { scrollTop?: number; composer?: string };
    // 恢复滚动位置（延迟到页面渲染后）
    if (state.scrollTop && state.scrollTop > 0) {
      setTimeout(() => {
        document.scrollingElement?.scrollTo({ top: state.scrollTop, behavior: "instant" as ScrollBehavior });
      }, 200);
    }
    // 恢复输入草稿
    if (state.composer) {
      setTimeout(() => {
        const textarea = getPromptTextarea();
        if (textarea && !textarea.value) {
          textarea.value = state.composer ?? "";
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, 500);
    }
  } catch { /* 忽略恢复失败 */ }
}

initConsoleLogPersistence();

/**
 * Remote Agent watcher (mobile input -> desktop execution).
 *
 * Runs as a lifecycle capability instead of a bare top-level call: every
 * content-script evaluation used to re-register the storage.onChanged listener
 * and the local-send listener, and the re-enable path started a watcher without
 * stopping the previous one or checking whether the setting really changed.
 */
function createRemoteAgentCapability(): ContentCapabilityController {
  return {
    id: "remote-agent",
    async start(scope) {
      remoteAgentCapabilityScope = scope;
      const isCurrent = () =>
        remoteAgentCapabilityScope === scope && scope.active;

      // Deduplicates "this browser already sent it"; must be installed even
      // when the watcher is currently off, because toggling the setting on
      // later would otherwise leave the watcher without any local-send record.
      scope.addCleanup("listener", setupLocalSendListener());
      scope.addCleanup(
        "listener",
        installRemoteAgentSettingListener(isCurrent),
      );

      const enabled = await readRemoteAgentSetting();
      if (!isCurrent()) return;
      applyRemoteAgentSetting(enabled);
    },
    stop() {
      remoteAgentCapabilityScope = null;
      stopRemoteAgentWatcher();
    },
  };
}

async function readRemoteAgentSetting(): Promise<boolean> {
  if (!hasLiveExtensionContext()) return false;
  try {
    const result = await chrome.storage.local.get("dpp_remote_agent_enabled");
    return result.dpp_remote_agent_enabled === true;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
    console.error("[DPP-REMOTE] Failed to read setting", error);
    return false;
  }
}

function installRemoteAgentSettingListener(
  isCurrent: () => boolean,
): () => void {
  if (!hasLiveExtensionContext()) return () => undefined;
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] =
    (changes, area) => {
      if (area !== "local" || !isCurrent()) return;
      const change = changes.dpp_remote_agent_enabled;
      if (!change) return;
      // Chrome fires onChanged for a same-value set() too (the sidepanel writes
      // the whole settings object), so only a real transition may restart things.
      if (change.oldValue === change.newValue) return;
      applyRemoteAgentSetting(change.newValue === true);
    };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function applyRemoteAgentSetting(enabled: boolean): void {
  // Stop before start so a toggle can never leave two overlapping poll chains
  // registered against the same module-level watcher state.
  stopRemoteAgentWatcher();
  if (!enabled) {
    console.log("[DPP-REMOTE] Watcher disabled");
    return;
  }
  const chatSessionId = getCurrentChatSessionId();
  if (!chatSessionId) {
    console.log("[DPP-REMOTE] No chat session, watcher not started");
    return;
  }
  startRemoteAgentWatcher({
    chatSessionId,
    // DPP-04: a dropped remote message must be visible, not just a log line.
    onResendFailed: () =>
      showContentToast(contentT("content.remoteAgent.resendFailed"), "warning"),
  });
  console.log("[DPP-REMOTE] Watcher initialized");
}

/**
 * Debug telemetry gate mirror.
 *
 * The sidepanel setting is the authoritative source, but the capture switch is
 * read in the MAIN world, so this capability copies it into the page's
 * localStorage gate. A missing key means "on" — manual `dpp_debug='0'` in the
 * page console keeps working as the fallback.
 */
function createDebugTelemetryCapability(): ContentCapabilityController {
  return {
    id: "debug-telemetry",
    async start(scope) {
      debugTelemetryCapabilityScope = scope;
      const isCurrent = () => debugTelemetryCapabilityScope === scope && scope.active;
      scope.addCleanup("listener", installDebugTelemetrySettingListener(isCurrent));

      let enabled = true;
      if (hasLiveExtensionContext()) {
        try {
          enabled = await readTelemetrySetting(chrome.storage.local);
        } catch (error) {
          if (isExtensionInvalidatedError(error)) invalidateExtensionContext();
        }
      }
      if (!isCurrent()) return;
      applyTelemetryGate(enabled);
    },
    stop() {
      debugTelemetryCapabilityScope = null;
    },
  };
}

function installDebugTelemetrySettingListener(
  isCurrent: () => boolean,
): () => void {
  if (!hasLiveExtensionContext()) return () => undefined;
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] =
    (changes, area) => {
      if (area !== "local" || !isCurrent()) return;
      const change = changes[TELEMETRY_SETTING_STORAGE_KEY];
      if (!change || change.oldValue === change.newValue) return;
      applyTelemetryGate(change.newValue !== false);
    };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function handleContentRuntimeMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
): boolean | undefined {
  let envelope;
  try {
    envelope = decodeRuntimeMessageEnvelope(message);
  } catch (error) {
    if (error instanceof RuntimeBoundaryError) return undefined;
    throw error;
  }

  try {
    createExtensionRuntimeMessageContext(sender, {
      runtimeId: chrome.runtime.id,
      extensionOrigin: chrome.runtime.getURL("/"),
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    });
  } catch (error) {
    // runtime.sendMessage reaches every extension context. A content receiver
    // must not answer a content-to-background RPC before the background does.
    if (error instanceof RuntimeBoundaryError) return undefined;
    throw error;
  }
  if (message.type === "STATE_UPDATED") {
    try {
      syncToMainWorld(
        decodeRuntimeMemories(message.memories, "memoryUpdate"),
        decodeSkillLibrary(message.skills, "skillUpdate"),
        decodeActivePreset(message.activePreset, "activePresetUpdate"),
        message.modelType,
        currentToolDescriptors,
        normalizePromptInjectionSettings(message.promptSettings),
        normalizeSkillAutoActivationSettings(message.skillAutoActivation),
      );
    } catch (error) {
      console.error("[DeepSeek++] memory state update rejected", error);
    }
  } else if (message.type === "TOOL_DESCRIPTORS_UPDATED") {
    const syncLease = toolDescriptorSyncGate.begin();
    try {
      const descriptors = decodeToolDescriptors(message.toolDescriptors);
      syncLease.commit(() =>
        syncToMainWorld(
          currentMemories,
          currentSkills,
          currentActivePreset,
          currentModelType,
          descriptors,
          currentPromptSettings,
        ),
      );
    } catch (error) {
      // Only a catalog that violates the released contract may disable tool
      // execution. An error from the sync itself (bridge, i18n, DOM) must not
      // take the last known descriptors away.
      if (isToolDescriptorContractError(error)) {
        syncLease.commit(() => reportToolDescriptorSyncFailure(error));
      } else {
        console.error(
          "[DeepSeek++] tool descriptor update rejected; keeping last known catalog",
          error,
        );
      }
    }
  } else if (message.type === "MCP_SERVERS_UPDATED") {
    const scope = multimodalCapabilityScope;
    if (scope && Array.isArray(message.servers)) {
      setMultimodalMediaInputEnabled(
        shouldEnableMultimodalMediaInput(message.servers),
      );
    } else if (scope) {
      void refreshMultimodalMediaInputAvailability(
        () => multimodalCapabilityScope === scope && scope.active,
      );
    }
    const runtimeScope = runtimeStateCapabilityScope;
    if (runtimeScope) {
      void refreshToolDescriptorsFromBackground(
        () =>
          runtimeStateCapabilityScope === runtimeScope && runtimeScope.active,
      );
    }
  } else if (message.type === "BACKGROUND_UPDATED") {
    if (backgroundCapabilityScope?.active) {
      applyBackground(message.config as BackgroundConfig | null);
    }
  } else if (message.type === "PET_UPDATED") {
    if (petCapabilityScope?.active)
      applyPetConfig(message.config as PetConfig | null);
  } else if (message.type === "REFRESH_DEEPSEEK_AUTH") {
    persistDeepSeekClientHeaders()
      .then((hasToken) => sendResponse({ ok: hasToken, hasToken }))
      .catch((error) =>
        sendResponse({
          ok: false,
          hasToken: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  } else if (message.type === "DEEPSEEK_EXPORT_PROGRESS") {
    if (exportCapabilityScope?.active) {
      updateConversationExportProgress(
        message.progress as ConversationExportProgress | undefined,
      );
    }
  } else if (message.type === "INSERT_PROMPT_TEXT") {
    sendResponse(
      insertPromptText(typeof message.text === "string" ? message.text : ""),
    );
    return true;
  } else if (message.type === "GET_CURRENT_DEEPSEEK_CONVERSATION") {
    const conversationId = getCurrentChatSessionId();
    sendResponse(
      conversationId
        ? {
            ok: true,
            conversation: {
              conversationId,
              title: getCurrentConversationTitle(),
              url: location.href,
            },
          }
        : { ok: false, error: "no_current_conversation" },
    );
    return true;
  }
  return undefined;
}

async function disconnectMainWorldRuntimeState(): Promise<void> {
  pendingToolAuthorizationCorrelations.terminateAll();
  try {
    await closeAllContentToolAuthorizations();
  } finally {
    activeToolAuthorizationRequestMetadata.clear();
    regenerateAuthorizationScopes.clear();
  }
}

async function handleAugmentRequestBody(data: {
  id?: unknown;
  requestId?: unknown;
  route?: unknown;
  body?: unknown;
}): Promise<void> {
  const id = typeof data.id === "string" ? data.id : "";
  const mainRequestId =
    typeof data.requestId === "string" ? data.requestId : "";
  if (!id) return;

  let authorization: ToolAuthorizationGrantSummary | null = null;
  let requestId = "";
  let tracksPendingAlias = false;
  try {
    if (typeof data.body !== "string") {
      throw new Error("Request body must be a string.");
    }
    if (!isDeepSeekAugmentableWebRoute(data.route)) {
      throw new Error("Request augmentation route is invalid.");
    }
    const decodedRequest = decodeAugmentableDeepSeekRequest(
      data.route,
      data.body,
    );
    if (!decodedRequest) {
      postAugmentRequestPassthrough(id);
      return;
    }

    const regenerateScope =
      decodedRequest.route === "regenerate"
        ? await resolveRegenerateAuthorizationScopeForRequest(
            decodedRequest.body,
          )
        : null;
    if (decodedRequest.route === "regenerate" && !regenerateScope) {
      // A regenerate request carries no prompt or trusted descriptor scope. If
      // the exact receiver-owned response scope is unavailable (for example
      // after a full page reload), preserve the native request but do not grant
      // the page/model a broader tool catalog.
      postAugmentRequestPassthrough(id);
      return;
    }
    if (!mainRequestId) {
      throw new Error("Request authorization identity is missing.");
    }
    if (
      toolAuthorizationRequestAliases.has(mainRequestId) ||
      !pendingToolAuthorizationCorrelations.begin(mainRequestId)
    ) {
      throw new Error("Request authorization correlation is already active.");
    }
    tracksPendingAlias = true;
    requestId = crypto.randomUUID();

    if (decodedRequest.route === "regenerate") {
      const scope = regenerateScope!;
      authorization = await createContentToolAuthorization({
        requestId,
        trigger: "manual_chat",
        chatSessionId: decodedRequest.body.chat_session_id,
        descriptorIds: scope.descriptorIds,
        localSkillDir: scope.activeLocalSkillDir,
      });
      activateContentToolAuthorization({
        mainRequestId,
        requestId,
        authorization,
        activeLocalSkillDir: scope.activeLocalSkillDir,
      });

      const requestAlreadyEnded =
        pendingToolAuthorizationCorrelations.activate(mainRequestId);
      tracksPendingAlias = false;
      if (requestAlreadyEnded) {
        throw new Error(
          "Request ended before its tool authorization became active.",
        );
      }

      postToMainWorld({
        type: "AUGMENT_REQUEST_BODY_RESULT",
        id,
        ok: true,
        result: {
          // Regenerate has no prompt to augment. Preserve the captured request
          // bytes exactly and attach only extension-owned parser/authorization
          // context outside the DeepSeek wire body.
          body: data.body,
          originalPrompt: scope.originalPrompt,
          agentTaskPrompt: scope.agentTaskPrompt,
          requestId,
          toolDescriptors: authorization.descriptors,
          promptOptions: scope.promptOptions,
          activeLocalSkillDir: scope.activeLocalSkillDir,
        },
      });
      return;
    }

    const decodedBody = decodedRequest.body;
    const bodyWithMultimodalMedia =
      await consumePendingMultimodalMediaForRequest(decodedBody, {
        onLongRunning(timeoutMs) {
          postToMainWorld({
            type: "AUGMENT_REQUEST_BODY_EXTEND_TIMEOUT",
            id,
            timeoutMs,
          });
        },
      });
    // Authorize first (without dir) for the augment's tool-descriptor filtering below.
    authorization = await createContentToolAuthorization({
      requestId,
      trigger: "manual_chat",
      chatSessionId: readRequestChatSessionId(bodyWithMultimodalMedia),
      toolIntent: bodyWithMultimodalMedia.prompt.slice(0, 16_000),
    });
    activeToolAuthorizations.set(requestId, authorization);
    toolAuthorizationRequestAliases.set(mainRequestId, requestId);
    const project = await resolveProjectContextForRequestBody(
      bodyWithMultimodalMedia,
    );

    const result = augmentDecodedRequestBody(bodyWithMultimodalMedia, {
      memories: currentMemories,
      skills: currentSkills,
      activePreset: currentActivePreset,
      projectContext: project?.context ?? null,
      projectId: project?.projectId ?? null,
      modelType: currentModelType,
      toolDescriptors: authorization.descriptors,
      messageCount: currentRequestMessageCount,
      locale: currentContentLocale,
      promptSettings: currentPromptSettings,
      skillAutoActivation: currentSkillAutoActivation,
    });

    currentRequestMessageCount = result.messageCount;
    if (result.usedMemoryIds.length > 0) {
      await sendRuntimeMessage({
        type: "TOUCH_MEMORIES",
        payload: { ids: result.usedMemoryIds },
      });
    }

    // Review #2: obtain the trusted activeLocalSkillDir from the augment result
    // (not the page message body), re-authorize with it so the grant binds the
    // local directory; background re-validates its ownership.
    // Close the previous dir-less grant first to avoid orphans, then create the
    // dir-bound grant and rebuild the alias mapping.
    await closeContentToolAuthorization(requestId);
    authorization = await createContentToolAuthorization({
      requestId,
      trigger: "manual_chat",
      chatSessionId: readRequestChatSessionId(bodyWithMultimodalMedia),
      toolIntent: bodyWithMultimodalMedia.prompt.slice(0, 16_000),
      localSkillDir: result.activeLocalSkillDir,
    });
    activateContentToolAuthorization({
      mainRequestId,
      requestId,
      authorization,
      activeLocalSkillDir: result.activeLocalSkillDir,
    });

    const requestAlreadyEnded =
      pendingToolAuthorizationCorrelations.activate(mainRequestId);
    tracksPendingAlias = false;
    if (requestAlreadyEnded) {
      throw new Error(
        "Request ended before its tool authorization became active.",
      );
    }

    postToMainWorld({
      type: "AUGMENT_REQUEST_BODY_RESULT",
      id,
      ok: true,
      result: {
        body: result.body,
        agentTaskPrompt: result.agentTaskPrompt,
        requestId,
        toolDescriptors: authorization.descriptors,
        activeLocalSkillDir: result.activeLocalSkillDir,
      },
    });
  } catch (error) {
    if (authorization) await closeContentToolAuthorization(requestId);
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
      postAugmentRequestPassthrough(id);
      return;
    }

    postToMainWorld({
      type: "AUGMENT_REQUEST_BODY_RESULT",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (tracksPendingAlias) {
      pendingToolAuthorizationCorrelations.finish(mainRequestId);
    }
  }
}

function postAugmentRequestPassthrough(id: string): void {
  postToMainWorld({
    type: "AUGMENT_REQUEST_BODY_RESULT",
    id,
    ok: true,
    result: null,
  });
}

function activateContentToolAuthorization(input: {
  mainRequestId: string;
  requestId: string;
  authorization: ToolAuthorizationGrantSummary;
  activeLocalSkillDir?: string;
}): void {
  activeToolAuthorizations.set(input.requestId, input.authorization);
  toolAuthorizationRequestAliases.set(input.mainRequestId, input.requestId);
  activeToolAuthorizationRequestMetadata.set(input.requestId, {
    ...(input.activeLocalSkillDir
      ? { activeLocalSkillDir: input.activeLocalSkillDir }
      : {}),
  });
}

function rememberRegenerateAuthorizationScope(
  complete: ResponseCompletePayload,
): void {
  if (!complete.requestId || complete.assistantMessageId == null) return;
  const authoritativeRequestId = activeToolAuthorizations.has(
    complete.requestId,
  )
    ? complete.requestId
    : toolAuthorizationRequestAliases.get(complete.requestId);
  if (!authoritativeRequestId) return;
  const authorization = activeToolAuthorizations.get(authoritativeRequestId);
  const metadata = activeToolAuthorizationRequestMetadata.get(
    authoritativeRequestId,
  );
  if (!authorization) return;
  // A grant created on /a/chat is intentionally unbound until the first tool
  // execution observes the browser-owned /a/chat/s/:id route. The summary in
  // this content realm remains null after background performs that binding,
  // so recover the same browser-owned route here instead of dropping replay
  // evidence for every newly created conversation.
  const chatSessionId =
    authorization.chatSessionId ?? getCurrentChatSessionId();
  if (!chatSessionId) return;

  regenerateAuthorizationScopes.remember({
    chatSessionId,
    assistantMessageId: complete.assistantMessageId,
    descriptorIds: authorization.descriptors.map((descriptor) => descriptor.id),
    originalPrompt: complete.originalPrompt,
    agentTaskPrompt: complete.agentTaskPrompt,
    promptOptions: cloneRegeneratePromptOptions(complete.promptOptions),
    activeLocalSkillDir: metadata?.activeLocalSkillDir,
  });
}

async function resolveRegenerateAuthorizationScopeForRequest(
  body: DeepSeekRegenerateRequestBody,
): Promise<RegenerateAuthorizationScope | null> {
  const liveScope = regenerateAuthorizationScopes.resolve(
    body.chat_session_id,
    body.child_message_id,
  );
  if (liveScope) return liveScope;

  let persistedBlocks: PersistedToolBlock[];
  try {
    persistedBlocks = await readPersistedToolExecutionBlocks();
  } catch (error) {
    console.error(
      "[DeepSeek++] persisted regenerate authorization evidence read failed",
      error,
    );
    return null;
  }

  const evidence = resolvePersistedRegenerateAuthorizationEvidence(
    persistedBlocks,
    body.chat_session_id,
    body.child_message_id,
  );
  if (!evidence) return null;

  const visiblePrompt = readVisibleRegeneratePrompt(
    persistedBlocks,
    body.chat_session_id,
    body.child_message_id,
  );
  return {
    chatSessionId: body.chat_session_id,
    assistantMessageId: body.child_message_id,
    descriptorIds: evidence.descriptorIds,
    originalPrompt: visiblePrompt,
    agentTaskPrompt: visiblePrompt,
    promptOptions:
      evidence.promptOptions ?? createRegeneratePromptOptionsFromRequest(body),
    activeLocalSkillDir: evidence.activeLocalSkillDir,
  };
}

function createRegeneratePromptOptionsFromRequest(
  body: DeepSeekRegenerateRequestBody,
): RegeneratePromptOptionsSnapshot {
  return {
    modelType: currentModelType,
    searchEnabled: body.search_enabled === true,
    thinkingEnabled: body.thinking_enabled === true,
    refFileIds: [],
  };
}

function readVisibleRegeneratePrompt(
  blocks: readonly PersistedToolBlock[],
  chatSessionId: string,
  assistantMessageId: number,
): string {
  const matchingBlock = [...blocks]
    .reverse()
    .find(
      (block) =>
        getToolRecordChatSessionId(block) === chatSessionId &&
        getToolRecordAssistantMessageId(block) === String(assistantMessageId),
    );
  const allMessages = Array.from(
    document.querySelectorAll<HTMLElement>(".ds-message"),
  );
  if (allMessages.length === 0) return "";

  const assistantMessages = getAssistantMessages();
  const target = matchingBlock
    ? findRestoredToolTarget(matchingBlock, assistantMessages, new Set())
    : (assistantMessages.find((message) =>
        elementHasMessageId(message, String(assistantMessageId)),
      ) ?? null);
  const targetIndex = target
    ? allMessages.indexOf(target as HTMLElement)
    : allMessages.length;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = allMessages[index];
    if (getAssistantContentHosts(candidate).length > 0) continue;
    const prompt = extractVisibleUserMessageText(candidate);
    if (prompt) return prompt;
  }
  return "";
}

function extractVisibleUserMessageText(message: HTMLElement): string {
  const clone = message.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      [
        '[class*="dpp-"]',
        "[data-dpp-agent]",
        "[data-dpp-body-text]",
        "[data-dpp-tool-key]",
        "button",
        '[role="button"]',
      ].join(","),
    )
    .forEach((node) => node.remove());
  return sanitizeInternalPromptText(clone.textContent?.trim() ?? "").slice(
    0,
    64_000,
  );
}

function cloneRegeneratePromptOptions(
  promptOptions: ResponseCompletePayload["promptOptions"],
): RegeneratePromptOptionsSnapshot {
  return {
    modelType: promptOptions.modelType,
    searchEnabled: promptOptions.searchEnabled,
    thinkingEnabled: promptOptions.thinkingEnabled,
    refFileIds: [...promptOptions.refFileIds],
  };
}

async function resolveProjectContextForRequestBody(
  body: Readonly<DeepSeekRequestBody>,
): Promise<ResolvedProjectAugmentationContext | null> {
  const sessionId =
    typeof body.chat_session_id === "string" && body.chat_session_id.trim()
      ? body.chat_session_id.trim()
      : getCurrentChatSessionId();
  if (!sessionId) return null;

  const bindPendingProject = body.parent_message_id === null;
  const project =
    await sendRuntimeMessageStrict<ResolvedProjectAugmentationContext | null>({
      type: "GET_PROJECT_CONTEXT_FOR_CONVERSATION",
      payload: {
        bindPendingProject,
        conversation: {
          conversationId: sessionId,
          title: getCurrentConversationTitle(),
          url: buildDeepSeekSessionUrl(sessionId),
        },
      },
    });
  return project ?? null;
}

function readRequestChatSessionId(
  body: Readonly<DeepSeekRequestBody>,
): string | null {
  return typeof body.chat_session_id === "string" && body.chat_session_id.trim()
    ? body.chat_session_id.trim()
    : getCurrentChatSessionId();
}

async function createContentToolAuthorization(input: {
  requestId: string;
  trigger: "manual_chat" | "agent_run";
  chatSessionId: string | null;
  runId?: string;
  descriptorIds?: string[];
  toolIntent?: string;
  /** Background-validated local-skill directory; page/model untrusted (Review #2) */
  localSkillDir?: string;
}): Promise<ToolAuthorizationGrantSummary> {
  return sendRuntimeMessageStrict<ToolAuthorizationGrantSummary>({
    type: "CREATE_TOOL_AUTHORIZATION",
    payload: input,
  });
}

async function closeContentToolAuthorization(requestId: string): Promise<void> {
  const authoritativeRequestId = activeToolAuthorizations.has(requestId)
    ? requestId
    : toolAuthorizationRequestAliases.get(requestId);
  if (!authoritativeRequestId) return;
  const authorization = activeToolAuthorizations.get(authoritativeRequestId);
  if (!authorization) return;
  if (!hasLiveExtensionContext()) {
    removeLocalToolAuthorization(authoritativeRequestId, authorization.id);
    return;
  }
  try {
    await sendRuntimeMessageStrict({
      type: "CLOSE_TOOL_AUTHORIZATION",
      payload: { authorizationId: authorization.id },
    });
    removeLocalToolAuthorization(authoritativeRequestId, authorization.id);
  } catch (error) {
    if (!isExtensionInvalidatedError(error)) throw error;
    invalidateExtensionContext();
    removeLocalToolAuthorization(authoritativeRequestId, authorization.id);
  }
}

function removeLocalToolAuthorization(
  requestId: string,
  authorizationId: string,
): void {
  activeToolAuthorizations.delete(requestId);
  activeToolAuthorizationRequestMetadata.delete(requestId);
  for (const key of pendingExternalToolPayloadWrites.keys()) {
    if (key.startsWith(`${authorizationId}:`))
      pendingExternalToolPayloadWrites.delete(key);
  }
  for (const [alias, target] of toolAuthorizationRequestAliases) {
    if (target === requestId) toolAuthorizationRequestAliases.delete(alias);
  }
  for (const [runId, target] of inlineAgentAuthorizationRequestKeys) {
    if (target === requestId) inlineAgentAuthorizationRequestKeys.delete(runId);
  }
}

async function closeAllContentToolAuthorizations(): Promise<void> {
  const results = await Promise.allSettled(
    [...activeToolAuthorizations.keys()].map(async (requestId) => {
      await waitForPendingToolExecutions(requestId);
      await finalizeInterruptedToolStarts(requestId);
      await closeContentToolAuthorization(requestId);
    }),
  );
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Failed to close content tool authorizations.",
    );
  }
}

function postToMainWorld(message: Record<string, unknown>): void {
  mainWorldBridgeController?.post(message);
}

async function loadAndSyncRuntimeState(
  syncLease: LatestSyncLease = toolDescriptorSyncGate.begin(),
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const descriptorResultPromise = (async () => {
    try {
      const value = await sendRuntimeMessageStrict<ToolDescriptor[]>({
        type: "GET_TOOL_DESCRIPTORS",
      });
      return { ok: true as const, descriptors: decodeToolDescriptors(value) };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();

  const runtimeStateSync = Promise.all([
    sendRuntimeMessageStrict<unknown>({ type: "GET_MEMORIES" }).then((value) =>
      decodeRuntimeMemories(value, "memoryResponse"),
    ),
    sendRuntimeMessageStrict<unknown>({ type: "GET_SKILLS" }).then((value) =>
      decodeSkillLibrary(value, "skillResponse"),
    ),
    sendRuntimeMessageStrict({ type: "GET_ACTIVE_PRESET" }, (value) =>
      decodeActivePreset(value, "activePresetResponse"),
    ),
    sendRuntimeMessage<ModelType>({ type: "GET_MODEL_TYPE" }),
    sendRuntimeMessage<PromptInjectionSettings>({
      type: "GET_PROMPT_INJECTION_SETTINGS",
    }),
    sendRuntimeMessage<SkillAutoActivationSettings>({
      type: "GET_SKILL_AUTO_ACTIVATION_SETTINGS",
    }),
  ]).then(
    ([
      memories,
      skills,
      activePreset,
      modelType,
      promptSettings,
      skillAutoActivation,
    ]) => {
      if (!isCurrent()) return;
      syncToMainWorld(
        memories,
        skills,
        activePreset,
        modelType ?? null,
        currentToolDescriptors,
        normalizePromptInjectionSettings(promptSettings),
        normalizeSkillAutoActivationSettings(skillAutoActivation),
      );
    },
    (error: unknown) => {
      if (isCurrent())
        console.error("[DeepSeek++] runtime state sync failed", error);
    },
  );

  const descriptorSync = descriptorResultPromise.then((descriptorResult) => {
    if (descriptorResult.ok) {
      syncLease.commit(() => {
        if (!isCurrent()) return;
        clearToolDescriptorRetry();
        syncToMainWorld(
          currentMemories,
          currentSkills,
          currentActivePreset,
          currentModelType,
          descriptorResult.descriptors,
          currentPromptSettings,
        );
      });
    } else {
      syncLease.commit(() => {
        if (!isCurrent()) return;
        if (isToolDescriptorContractError(descriptorResult.error)) {
          reportToolDescriptorSyncFailure(descriptorResult.error);
          return;
        }
        retainToolDescriptorsAfterTransportFailure(descriptorResult.error);
        scheduleToolDescriptorRetry(isCurrent);
      });
    }
  });

  await Promise.all([runtimeStateSync, descriptorSync]);
}

async function refreshToolDescriptorsFromBackground(
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const syncLease = toolDescriptorSyncGate.begin();
  try {
    const descriptors = decodeToolDescriptors(
      await sendRuntimeMessageStrict<ToolDescriptor[]>({
        type: "GET_TOOL_DESCRIPTORS",
      }),
    );
    syncLease.commit(() => {
      if (!isCurrent()) return;
      clearToolDescriptorRetry();
      syncToMainWorld(
        currentMemories,
        currentSkills,
        currentActivePreset,
        currentModelType,
        descriptors,
        currentPromptSettings,
      );
    });
  } catch (error) {
    syncLease.commit(() => {
      if (!isCurrent()) return;
      if (isToolDescriptorContractError(error)) {
        reportToolDescriptorSyncFailure(error);
        return;
      }
      retainToolDescriptorsAfterTransportFailure(error);
      scheduleToolDescriptorRetry(isCurrent);
    });
  }
}

function hasLiveExtensionContext(): boolean {
  if (!extensionContextValid) return false;

  try {
    if (typeof chrome === "undefined") {
      invalidateExtensionContext();
      return false;
    }
    const runtime = chrome.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== "function") {
      invalidateExtensionContext();
      return false;
    }
    return true;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
    }
    return false;
  }
}

function installExtensionInvalidationGuards(): () => void {
  const suppressInvalidation = (event: PromiseRejectionEvent | ErrorEvent) => {
    const error =
      "reason" in event ? event.reason : (event.error ?? event.message);
    if (!isExtensionInvalidatedError(error)) return;
    invalidateExtensionContext();
    event.preventDefault();
  };

  window.addEventListener("unhandledrejection", suppressInvalidation);
  window.addEventListener("error", suppressInvalidation);
  return () => {
    window.removeEventListener("unhandledrejection", suppressInvalidation);
    window.removeEventListener("error", suppressInvalidation);
  };
}

function isExtensionInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Extension context invalidated") ||
    message.includes("context invalidated") ||
    message.includes("Extension context is unavailable")
  );
}

function invalidateExtensionContext() {
  if (!extensionContextValid) return;
  extensionContextValid = false;
  const lifecycle = contentDocumentLifecycle;
  contentDocumentLifecycle = null;
  // Once Chrome invalidates the context there is no way to revive the page-side
  // chrome.* handles, so the only useful signal left is telling the user to
  // reload the page (previously this happened silently).
  showContentToast(contentT("content.agent.contextInvalidated"), "warning");
  void lifecycle
    ?.dispose("extension-invalidated")
    .catch(reportContentLifecycleError);
}

/** Isolated world writes captured DeepSeek request headers to chrome.storage. */
async function persistDeepSeekClientHeaders(
  capturedHeaders?: Record<string, string> | null,
): Promise<boolean> {
  try {
    const headers = capturedHeaders ?? createClientHeaders();
    if (headers) {
      rememberDeepSeekClientHeaders(headers);
      const saved = await saveClientHeadersToStorage();
      if (!saved) return false;
      // Ask the sidepanel to re-check login status.
      return notifyContentAuthStatusChanged({
        send: () => chrome.runtime.sendMessage({ type: "AUTH_STATUS_CHANGED" }),
        isExtensionInvalidatedError,
        invalidateExtensionContext,
        reportError(error) {
          console.error("[DeepSeek++] auth status notification failed", error);
        },
      });
    }
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
    } else {
      console.error(
        "[DeepSeek++] DeepSeek client header persistence failed",
        error,
      );
    }
  }
  return false;
}

function startConversationExportActionInjector() {
  exportActionRetryAttempts = 0;
  injectConversationExportActionStyles();
  mountConversationExportActions();
  armConversationExportActionRetry();
}

function stopConversationExportActionInjector() {
  clearConversationExportActionTimers();
  exportActionRetryAttempts = 0;
  closeConversationExportMenu();
  document
    .querySelectorAll(`.${EXPORT_ACTION_CLASS}, .${EXPORT_ACTION_TOAST_CLASS}`)
    .forEach((el) => el.remove());
  document.getElementById(EXPORT_ACTION_STYLE_ID)?.remove();
}

function clearConversationExportActionTimers() {
  if (exportActionMountTimer) {
    clearTimeout(exportActionMountTimer);
    exportActionMountTimer = null;
  }
  if (exportActionRetryTimer) {
    clearTimeout(exportActionRetryTimer);
    exportActionRetryTimer = null;
  }
  if (exportActionToastTimer) {
    clearTimeout(exportActionToastTimer);
    exportActionToastTimer = null;
  }
}

function scheduleConversationExportActionMount() {
  if (exportActionMountTimer) return;
  exportActionMountTimer = setTimeout(() => {
    exportActionMountTimer = null;
    mountConversationExportActions();
  }, EXPORT_ACTION_MOUNT_DEBOUNCE_MS);
}

function mutationMayAffectConversationExportActions(
  mutation: MutationRecord,
): boolean {
  if (mutation.type !== "childList") return false;
  for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
    if (
      !nodeMatchesOrContains(
        node,
        '.ds-message, button, [role="button"].ds-button',
      )
    )
      continue;
    if (node instanceof Element && node.closest(`.${EXPORT_ACTION_MENU_CLASS}`))
      continue;
    return true;
  }
  return false;
}

function armConversationExportActionRetry() {
  if (exportActionRetryAttempts >= EXPORT_ACTION_RETRY_LIMIT) return;
  if (exportActionRetryTimer) clearTimeout(exportActionRetryTimer);
  exportActionRetryTimer = setTimeout(() => {
    exportActionRetryTimer = null;
    exportActionRetryAttempts += 1;
    const mountedCount = mountConversationExportActions();
    if (mountedCount === 0) armConversationExportActionRetry();
  }, EXPORT_ACTION_RETRY_MS);
}

function mountConversationExportActions(): number {
  const sessionId = getCurrentChatSessionId();
  closeConversationExportMenuIfSessionChanged(sessionId);
  if (!sessionId) {
    removeConversationExportActions();
    return 0;
  }

  const messages = getAssistantExportMessages();
  const mountedRows = new Set<HTMLElement>();
  let mountedCount = 0;

  for (const message of messages) {
    const officialRow = findAssistantMessageActionRow(message);
    if (officialRow) {
      ensureConversationExportButton(officialRow, sessionId);
      mountedRows.add(officialRow);
      mountedCount += 1;
    }
  }

  for (const row of findGlobalAssistantActionRows()) {
    if (mountedRows.has(row)) continue;
    ensureConversationExportButton(row, sessionId);
    mountedRows.add(row);
    mountedCount += 1;
  }

  renderTokenSpeedIndicator(lastTokenSpeedProgress);
  return mountedCount;
}

function removeConversationExportActions() {
  document
    .querySelectorAll(`.${EXPORT_ACTION_CLASS}`)
    .forEach((el) => el.remove());
  removeTokenSpeedIndicator();
}

function getAssistantExportMessages(): Element[] {
  return Array.from(document.querySelectorAll(".ds-message")).filter(
    (message) => getAssistantContentHosts(message).length > 0,
  );
}

function findAssistantMessageActionRow(message: Element): HTMLElement | null {
  const responseHost = getAssistantResponseHost(message);
  const controls = getDeepSeekActionControls(message).filter((control) =>
    isOfficialActionControlCandidate(control, responseHost),
  );

  for (const control of controls) {
    const row = findCompactActionRow(control, message, responseHost);
    if (row) return row;
  }

  return null;
}

function getDeepSeekActionControls(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(DEEPSEEK_ACTION_CONTROL_SELECTOR),
  );
}

function isOfficialActionControlCandidate(
  control: HTMLElement,
  responseHost: Element,
): boolean {
  if (control.classList.contains(EXPORT_ACTION_CLASS)) return false;
  if (responseHost.contains(control)) return false;
  if (control.closest(".dpp-tool-block, .dpp-agent-container")) return false;
  if (!isVisibleElement(control)) return false;

  const rect = control.getBoundingClientRect();
  if (rect.width > 64 || rect.height > 64) return false;
  return true;
}

function findCompactActionRow(
  control: HTMLElement,
  message: Element,
  responseHost: Element,
): HTMLElement | null {
  let el: HTMLElement | null = control.parentElement;
  let depth = 0;
  while (el && el !== message && depth < 6) {
    const rowControls = getDeepSeekActionControls(el).filter((candidate) =>
      isOfficialActionControlCandidate(candidate, responseHost),
    );
    if (rowControls.length >= 4 && isCompactActionRow(el, responseHost))
      return el;
    el = el.parentElement;
    depth += 1;
  }
  return null;
}

function isCompactActionRow(row: HTMLElement, responseHost: Element): boolean {
  const rowRect = row.getBoundingClientRect();
  const responseRect = responseHost.getBoundingClientRect();
  if (rowRect.width === 0 || rowRect.height === 0) return false;
  if (rowRect.height > 72) return false;
  if (responseRect.height > 0 && rowRect.top < responseRect.bottom - 12)
    return false;
  return true;
}

function findGlobalAssistantActionRows(): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  const controls = getDeepSeekActionControls(document).filter(
    isGlobalActionControlCandidate,
  );

  for (const control of controls) {
    const row = findGlobalCompactActionRow(control);
    if (row) rows.add(row);
  }

  return [...rows].sort(
    (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
  );
}

function isGlobalActionControlCandidate(control: HTMLElement): boolean {
  if (control.classList.contains(EXPORT_ACTION_CLASS)) return false;
  if (control.closest(".dpp-tool-block, .dpp-agent-container")) return false;
  if (
    control.closest('aside, nav, header, [role="navigation"], [role="banner"]')
  )
    return false;
  if (findDeepSeekInputBox()?.contains(control)) return false;
  if (!isVisibleElement(control)) return false;

  const rect = control.getBoundingClientRect();
  if (rect.width > 64 || rect.height > 64) return false;
  if (rect.left < getConversationViewportLeft()) return false;

  const textarea = getPromptTextarea();
  const textareaTop =
    textarea?.getBoundingClientRect().top ?? window.innerHeight;
  if (rect.bottom >= textareaTop - 12) return false;
  return true;
}

function findGlobalCompactActionRow(control: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = control.parentElement;
  let depth = 0;
  while (el && el !== document.body && depth < 6) {
    const rowControls = getDeepSeekActionControls(el).filter(
      isGlobalActionControlCandidate,
    );
    if (rowControls.length >= 4 && isLikelyReplyActionRow(el, rowControls))
      return el;
    el = el.parentElement;
    depth += 1;
  }
  return null;
}

function isLikelyReplyActionRow(
  row: HTMLElement,
  rowControls: HTMLElement[],
): boolean {
  const rowRect = row.getBoundingClientRect();
  if (rowRect.width === 0 || rowRect.height === 0) return false;
  if (rowRect.height > 72) return false;

  const textarea = getPromptTextarea();
  const textareaTop =
    textarea?.getBoundingClientRect().top ?? window.innerHeight;
  if (rowRect.bottom >= textareaTop - 12) return false;

  const sortedControls = rowControls
    .map((control) => control.getBoundingClientRect())
    .sort((a, b) => a.left - b.left);
  const first = sortedControls[0];
  const last = sortedControls[sortedControls.length - 1];
  if (!first || !last) return false;
  return last.right - first.left <= 260;
}

function getConversationViewportLeft(): number {
  const textarea = getPromptTextarea();
  const inputBox = findDeepSeekInputBox();
  const rect = (inputBox ?? textarea)?.getBoundingClientRect();
  if (rect?.left && rect.left > 0) return Math.max(180, rect.left - 80);
  return 180;
}

function ensureConversationExportButton(
  row: HTMLElement,
  sessionId: string,
): HTMLButtonElement {
  let button = row.querySelector<HTMLButtonElement>(
    `:scope > .${EXPORT_ACTION_CLASS}`,
  );
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = EXPORT_ACTION_CLASS;
    button.innerHTML = createConversationExportActionIcon();
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (activeConversationExportId) return;
      toggleConversationExportMenu(button!);
    });
  }

  placeConversationExportButton(row, button);
  button.dataset.dppExportSessionId = sessionId;
  applyConversationExportButtonStatus(
    button,
    activeConversationExportId ? "running" : "idle",
  );
  return button;
}

function placeConversationExportButton(
  row: HTMLElement,
  button: HTMLButtonElement,
): void {
  const officialControls = getDeepSeekActionControls(row)
    .filter(
      (control) =>
        !control.classList.contains(EXPORT_ACTION_CLASS) &&
        isVisibleElement(control),
    )
    .sort(
      (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
    );
  const lastOfficialControl = officialControls[officialControls.length - 1];

  if (!lastOfficialControl || lastOfficialControl.parentElement !== row) {
    if (button.parentElement !== row) row.appendChild(button);
    return;
  }

  if (lastOfficialControl.nextElementSibling !== button) {
    lastOfficialControl.insertAdjacentElement("afterend", button);
  }
}

function applyConversationExportButtonStatus(
  button: HTMLButtonElement,
  status: "idle" | "running",
) {
  const running = status === "running";
  button.disabled = running;
  button.dataset.status = status;
  button.title = running
    ? contentT("content.export.buttonRunning")
    : contentT("content.export.buttonIdle");
  button.setAttribute("aria-label", button.title);
}

function setConversationExportButtonsStatus(status: "idle" | "running") {
  document
    .querySelectorAll<HTMLButtonElement>(`.${EXPORT_ACTION_CLASS}`)
    .forEach((button) => applyConversationExportButtonStatus(button, status));
}

function toggleConversationExportMenu(button: HTMLButtonElement) {
  if (exportActionMenuEl && exportActionMenuButton === button) {
    closeConversationExportMenu();
    return;
  }
  showConversationExportMenu(button);
}

function showConversationExportMenu(button: HTMLButtonElement) {
  closeConversationExportMenu();

  const sessionId = getCurrentChatSessionId();
  if (!sessionId) {
    showConversationExportToast(
      contentT("content.export.emptyConversation"),
      "error",
    );
    return;
  }

  const menu = document.createElement("div");
  menu.className = EXPORT_ACTION_MENU_CLASS;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", contentT("content.export.formatDialogLabel"));
  menu.addEventListener("click", (event) => event.stopPropagation());

  const form = document.createElement("form");
  const title = document.createElement("div");
  title.className = "dpp-export-menu-title";
  title.textContent = contentT("content.export.formatTitle");
  form.appendChild(title);

  for (const option of CONVERSATION_EXPORT_FORMAT_OPTIONS) {
    const label = document.createElement("label");
    label.className = "dpp-export-menu-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "format";
    input.value = option.format;
    input.checked = option.defaultChecked;
    const text = document.createElement("span");
    text.textContent = contentT(option.labelKey);
    label.append(input, text);
    form.appendChild(label);
  }

  const scopeTitle = document.createElement("div");
  scopeTitle.className = "dpp-export-menu-title";
  scopeTitle.textContent = contentT("content.export.scopeLabel");
  form.appendChild(scopeTitle);

  const initialScope = getStoredConversationExportScope();
  for (const option of CONVERSATION_EXPORT_SCOPE_OPTIONS) {
    const label = document.createElement("label");
    label.className = "dpp-export-menu-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "contentScope";
    input.value = option.scope;
    input.checked = initialScope === option.scope;
    const text = document.createElement("span");
    text.textContent = contentT(option.labelKey);
    label.append(input, text);
    form.appendChild(label);
  }

  const actions = document.createElement("div");
  actions.className = "dpp-export-menu-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = contentT("common.cancel");
  cancel.addEventListener("click", () => closeConversationExportMenu());
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = contentT("content.export.submit");
  actions.append(cancel, submit);
  form.appendChild(actions);

  form.addEventListener("change", () => {
    submit.disabled = getSelectedConversationExportFormats(menu).length === 0;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formats = getSelectedConversationExportFormats(menu);
    if (formats.length === 0) return;
    const scope = getSelectedConversationExportScope(menu);
    storeConversationExportScope(scope);
    closeConversationExportMenu();
    void startCurrentConversationExport(formats, scope);
  });

  menu.appendChild(form);
  document.body.appendChild(menu);
  exportActionMenuEl = menu;
  exportActionMenuButton = button;
  exportActionMenuSessionId = sessionId;
  positionConversationExportMenu(menu, button);
  document.addEventListener(
    "click",
    handleConversationExportMenuDocumentClick,
    true,
  );
  document.addEventListener(
    "keydown",
    handleConversationExportMenuKeydown,
    true,
  );
}

function positionConversationExportMenu(
  menu: HTMLElement,
  button: HTMLButtonElement,
) {
  const buttonRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 8;
  const margin = 12;
  const belowTop = buttonRect.bottom + gap;
  const aboveTop = buttonRect.top - menuRect.height - gap;
  const top =
    belowTop + menuRect.height <= window.innerHeight - margin
      ? belowTop
      : Math.max(margin, aboveTop);
  const left = Math.min(
    window.innerWidth - menuRect.width - margin,
    Math.max(
      margin,
      buttonRect.left + buttonRect.width / 2 - menuRect.width / 2,
    ),
  );
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

function getSelectedConversationExportFormats(
  menu: HTMLElement,
): ConversationExportArtifact["format"][] {
  return Array.from(
    menu.querySelectorAll<HTMLInputElement>('input[name="format"]:checked'),
  )
    .map((input) => input.value)
    .filter(isConversationExportUiFormat);
}

function isConversationExportUiFormat(
  value: string,
): value is ConversationExportArtifact["format"] {
  return CONVERSATION_EXPORT_FORMAT_OPTIONS.some(
    (option) => option.format === value,
  );
}

function closeConversationExportMenu() {
  document.removeEventListener(
    "click",
    handleConversationExportMenuDocumentClick,
    true,
  );
  document.removeEventListener(
    "keydown",
    handleConversationExportMenuKeydown,
    true,
  );
  exportActionMenuEl?.remove();
  exportActionMenuEl = null;
  exportActionMenuButton = null;
  exportActionMenuSessionId = null;
}

function closeConversationExportMenuIfSessionChanged(
  sessionId = getCurrentChatSessionId(),
) {
  if (!exportActionMenuEl) return;
  if (sessionId === exportActionMenuSessionId) return;
  closeConversationExportMenu();
}

function handleConversationExportMenuDocumentClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (exportActionMenuEl?.contains(target)) return;
  if (exportActionMenuButton?.contains(target)) return;
  closeConversationExportMenu();
}

function handleConversationExportMenuKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  closeConversationExportMenu();
}

async function startCurrentConversationExport(
  selectedFormats: ConversationExportArtifact["format"][] = ["html"],
  contentScope: ConversationExportContentScope = "full",
) {
  if (activeConversationExportId) return;
  const sessionId = getCurrentChatSessionId();
  if (!sessionId) {
    showConversationExportToast(
      contentT("content.export.emptyConversation"),
      "error",
    );
    return;
  }

  const formats = dedupeConversationExportUiFormats(selectedFormats);
  const exportId = crypto.randomUUID();
  activeConversationExportId = exportId;
  setConversationExportButtonsStatus("running");
  showConversationExportToast(contentT("content.export.progress"), "info");

  try {
    const response = await sendConversationExportRequest(
      exportId,
      sessionId,
      formats,
      contentScope,
    );
    if (!response?.ok) {
      throw new Error(response?.error ?? contentT("content.export.failed"));
    }

    const artifacts = response.artifacts.filter((artifact) =>
      formats.includes(artifact.format),
    );
    if (artifacts.length !== formats.length) {
      throw new Error(contentT("content.export.failed"));
    }
    downloadConversationExportArtifacts(artifacts);

    const warning = response.summary.failedSessionCount > 0;
    showConversationExportToast(
      warning
        ? contentT("content.export.partialSuccess")
        : getConversationExportSuccessMessage(formats),
      warning ? "warning" : "success",
    );
  } catch (error) {
    showConversationExportToast(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  } finally {
    if (activeConversationExportId === exportId) {
      activeConversationExportId = null;
      setConversationExportButtonsStatus("idle");
    }
  }
}

function dedupeConversationExportUiFormats(
  formats: ConversationExportArtifact["format"][],
): ConversationExportArtifact["format"][] {
  const values = formats.filter(isConversationExportUiFormat);
  const deduped = values.filter(
    (format, index) => values.indexOf(format) === index,
  );
  return deduped.length > 0 ? deduped : ["html"];
}

function getConversationExportSuccessMessage(
  formats: ConversationExportArtifact["format"][],
): string {
  if (formats.includes("pdf")) {
    return contentT("content.export.success");
  }
  return contentT("content.export.success");
}

async function sendConversationExportRequest(
  exportId: string,
  sessionId: string,
  formats: ConversationExportArtifact["format"][],
  contentScope: ConversationExportContentScope = "full",
): Promise<ExportResponse | undefined> {
  if (!hasLiveExtensionContext()) return undefined;
  try {
    return (await chrome.runtime.sendMessage({
      type: "EXPORT_DEEPSEEK_CONVERSATIONS",
      payload: {
        exportId,
        request: {
          mode: "sanitized",
          contentScope,
          formats,
          includeAttachmentMetadata: true,
          includeFileBodies: false,
          sessionIds: [sessionId],
        },
      },
    })) as ExportResponse;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
      return undefined;
    }
    throw error;
  }
}

function updateConversationExportProgress(
  progress: ConversationExportProgress | undefined,
) {
  if (!progress || progress.exportId !== activeConversationExportId) return;
  if (progress.status === "running") {
    setConversationExportButtonsStatus("running");
  }
}

function getCurrentChatSessionId(): string | null {
  return readDeepSeekChatSessionId(location.pathname);
}

function getCurrentConversationTitle(): string {
  const title = document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, "").trim();
  return title || contentT("content.conversation.untitled");
}

async function refreshMultimodalMediaInputAvailability(
  isCurrent: () => boolean = () => true,
) {
  try {
    const servers = await sendRuntimeMessageStrict<McpServerConfig[]>({
      type: "GET_MCP_SERVERS",
    });
    if (!isCurrent()) return;
    setMultimodalMediaInputEnabled(shouldEnableMultimodalMediaInput(servers));
  } catch (error) {
    if (!isCurrent()) return;
    setMultimodalMediaInputEnabled(false);
    if (hasLiveExtensionContext()) {
      console.warn(
        "[DeepSeek++] Failed to load MCP servers for multimodal media input.",
        error,
      );
    }
  }
}

function shouldEnableMultimodalMediaInput(servers: unknown): boolean {
  return (
    Array.isArray(servers) &&
    servers.some(
      (server) =>
        Boolean(server && typeof server === "object") &&
        canUseMultimodalMediaInput(server as McpServerConfig),
    )
  );
}

function setMultimodalMediaInputEnabled(enabled: boolean) {
  if (multimodalMediaInputEnabled === enabled) {
    if (enabled) mountMultimodalMediaControls();
    return;
  }

  multimodalMediaInputEnabled = enabled;
  if (enabled) {
    startMultimodalMediaInput();
    return;
  }
  stopMultimodalMediaInput();
}

function startMultimodalMediaInput() {
  if (!multimodalMediaInputEnabled) return;
  injectMultimodalMediaStyles();
  mountMultimodalMediaControls();
  document.removeEventListener("paste", handleMultimodalMediaPaste, true);
  document.addEventListener("paste", handleMultimodalMediaPaste, true);
}

function stopMultimodalMediaInput() {
  if (multimodalMediaMountTimer) {
    clearTimeout(multimodalMediaMountTimer);
    multimodalMediaMountTimer = null;
  }
  document.removeEventListener("paste", handleMultimodalMediaPaste, true);
  removeMultimodalMediaControls();
  clearPendingMultimodalMedia();
  document.getElementById(MULTIMODAL_MEDIA_STYLE_ID)?.remove();
}

function scheduleMultimodalMediaMount() {
  if (!multimodalMediaInputEnabled) return;
  if (multimodalMediaMountTimer) return;
  multimodalMediaMountTimer = setTimeout(() => {
    multimodalMediaMountTimer = null;
    mountMultimodalMediaControls();
  }, MULTIMODAL_MEDIA_MOUNT_DEBOUNCE_MS);
}

function mutationMayAffectPromptControls(mutation: MutationRecord): boolean {
  if (mutation.type !== "childList") return false;
  const textarea = getPromptTextarea();
  if (
    textarea &&
    mutation.target instanceof Node &&
    (textarea.contains(mutation.target) ||
      (mutation.target instanceof Element &&
        mutation.target.contains(textarea)))
  )
    return true;

  const selector = [
    "textarea",
    `#${MULTIMODAL_MEDIA_BUTTON_ID}`,
    `#${MULTIMODAL_MEDIA_FILE_INPUT_ID}`,
    `#${MULTIMODAL_MEDIA_TRAY_ID}`,
  ].join(", ");
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
    nodeMatchesOrContains(node, selector),
  );
}

function nodeMatchesOrContains(node: Node, selector: string): boolean {
  if (node instanceof Element)
    return node.matches(selector) || Boolean(node.querySelector(selector));
  if (node instanceof DocumentFragment)
    return Boolean(node.querySelector(selector));
  return false;
}

function mountMultimodalMediaControls() {
  if (!multimodalMediaInputEnabled) {
    removeMultimodalMediaControls();
    return;
  }
  injectMultimodalMediaStyles();
  const inputBox = findDeepSeekInputBox();
  if (!inputBox) return;

  if (
    multimodalMediaButtonEl?.isConnected &&
    multimodalMediaButtonEl.parentElement === inputBox
  ) {
    updateMultimodalMediaButtonPlacement(inputBox);
    if (multimodalMediaTrayEl)
      placeMultimodalMediaTray(inputBox, multimodalMediaTrayEl);
    renderMultimodalMediaTray();
    return;
  }

  removeMultimodalMediaControls({ keepMedia: true });
  inputBox.setAttribute("data-dpp-multimodal-media-anchor", "");

  const fileInput = document.createElement("input");
  fileInput.id = MULTIMODAL_MEDIA_FILE_INPUT_ID;
  fileInput.type = "file";
  fileInput.accept = "image/*,video/*";
  fileInput.multiple = true;
  fileInput.className = "dpp-mm-file-input";
  fileInput.addEventListener("click", stopMultimodalMediaFileInputEvent, true);
  fileInput.addEventListener("input", stopMultimodalMediaFileInputEvent, true);
  fileInput.addEventListener(
    "change",
    (event) => {
      stopMultimodalMediaFileInputEvent(event);
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      void addPendingMultimodalFiles(files, "picker");
    },
    true,
  );

  const button = document.createElement("button");
  button.id = MULTIMODAL_MEDIA_BUTTON_ID;
  button.type = "button";
  button.className = "dpp-mm-button";
  button.title = contentT("content.multimodalMedia.buttonTitle");
  button.setAttribute(
    "aria-label",
    contentT("content.multimodalMedia.buttonTitle"),
  );
  button.innerHTML = createMultimodalMediaButtonIcon();
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openMultimodalMediaPicker(fileInput);
  });

  const tray = document.createElement("div");
  tray.id = MULTIMODAL_MEDIA_TRAY_ID;
  tray.className = "dpp-mm-tray";

  const status = document.createElement("div");
  status.id = MULTIMODAL_MEDIA_STATUS_ID;
  status.className = "dpp-mm-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  tray.append(status);
  document.body.append(fileInput);
  placeMultimodalMediaTray(inputBox, tray);
  inputBox.append(button);
  multimodalMediaFileInputEl = fileInput;
  multimodalMediaButtonEl = button;
  multimodalMediaTrayEl = tray;
  multimodalMediaStatusEl = status;
  updateMultimodalMediaButtonPlacement(inputBox);
  renderMultimodalMediaTray();
}

function placeMultimodalMediaTray(inputBox: HTMLElement, tray: HTMLElement) {
  const parent = inputBox.parentElement;
  if (!parent) return;
  if (tray.parentElement === parent && tray.nextElementSibling === inputBox)
    return;
  parent.insertBefore(tray, inputBox);
}

async function openMultimodalMediaPicker(fileInput: HTMLInputElement) {
  const picker = getBrowserFilePicker();
  if (!picker) {
    fileInput.click();
    return;
  }

  try {
    const handles = await picker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: "Images and videos",
          accept: {
            "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"],
            "video/*": [".mp4", ".mov", ".webm", ".m4v"],
          },
        },
      ],
    });
    const files = await Promise.all(handles.map((handle) => handle.getFile()));
    await addPendingMultimodalFiles(files, "picker");
  } catch (error) {
    if (isFilePickerAbort(error)) return;
    throw error;
  }
}

function getBrowserFilePicker():
  | ((options: {
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<Array<{ getFile(): Promise<File> }>>)
  | null {
  const candidate = (
    window as Window & {
      showOpenFilePicker?: (options: {
        multiple?: boolean;
        excludeAcceptAllOption?: boolean;
        types?: Array<{
          description?: string;
          accept: Record<string, string[]>;
        }>;
      }) => Promise<Array<{ getFile(): Promise<File> }>>;
    }
  ).showOpenFilePicker;
  return typeof candidate === "function" ? candidate.bind(window) : null;
}

function isFilePickerAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function stopMultimodalMediaFileInputEvent(event: Event) {
  if (event.type !== "click") event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function removeMultimodalMediaControls(options: { keepMedia?: boolean } = {}) {
  const parent =
    multimodalMediaButtonEl?.parentElement ??
    multimodalMediaTrayEl?.parentElement;
  multimodalMediaButtonEl?.remove();
  multimodalMediaFileInputEl?.remove();
  multimodalMediaTrayEl?.remove();
  multimodalMediaStatusEl?.remove();
  parent?.removeAttribute("data-dpp-multimodal-media-anchor");
  parent?.removeAttribute("data-dpp-multimodal-media-has-native");
  parent?.removeAttribute("data-dpp-multimodal-media-has-items");
  multimodalMediaButtonEl = null;
  multimodalMediaFileInputEl = null;
  multimodalMediaTrayEl = null;
  multimodalMediaStatusEl = null;
  if (!options.keepMedia) clearPendingMultimodalMedia();
}

function updateMultimodalMediaButtonPlacement(inputBox: HTMLElement) {
  inputBox.setAttribute(
    "data-dpp-multimodal-media-has-native",
    hasNativePromptAttachmentButton(inputBox) ? "true" : "false",
  );
}

function hasNativePromptAttachmentButton(inputBox: HTMLElement): boolean {
  const inputRect = inputBox.getBoundingClientRect();
  const buttons = Array.from(
    inputBox.querySelectorAll<HTMLElement>('button, [role="button"]'),
  )
    .filter((button) => button.id !== MULTIMODAL_MEDIA_BUTTON_ID)
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const centerX = rect.left + rect.width / 2;
      return centerX > inputRect.right - 220;
    });
  return buttons.length >= 2;
}

function renderMultimodalMediaTray() {
  if (!multimodalMediaTrayEl?.isConnected) return;
  const items = getCurrentRoutePendingMultimodalMedia();
  const anchor = multimodalMediaButtonEl?.parentElement;
  const hasVisibleStatus = Boolean(
    multimodalMediaStatusEl?.textContent &&
    (multimodalMediaBusy || multimodalMediaStatusEl.dataset.tone === "error"),
  );
  const isVisible = items.length > 0 || hasVisibleStatus;
  anchor?.setAttribute(
    "data-dpp-multimodal-media-has-items",
    isVisible ? "true" : "false",
  );
  multimodalMediaTrayEl.dataset.visible = isVisible ? "true" : "false";
  multimodalMediaButtonEl?.toggleAttribute("disabled", multimodalMediaBusy);
  multimodalMediaButtonEl?.classList.toggle("is-busy", multimodalMediaBusy);

  multimodalMediaTrayEl.textContent = "";
  const list = document.createElement("div");
  list.className = "dpp-mm-list";
  for (const item of items) {
    const chip = document.createElement("div");
    chip.className = "dpp-mm-chip";

    if (item.kind === "image" && item.objectUrl) {
      const preview = document.createElement("img");
      preview.className = "dpp-mm-preview";
      preview.src = item.objectUrl;
      preview.alt = "";
      chip.append(preview);
    } else {
      const preview = document.createElement("span");
      preview.className = "dpp-mm-preview dpp-mm-preview-file";
      preview.textContent = item.kind === "video" ? "V" : "I";
      chip.append(preview);
    }

    const label = document.createElement("span");
    label.className = "dpp-mm-name";
    label.textContent = `${item.name} · ${formatMultimodalMediaBytes(item.sizeBytes)}`;
    chip.append(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dpp-mm-remove";
    remove.title = contentT("content.multimodalMedia.removeTitle", {
      name: item.name,
    });
    remove.setAttribute(
      "aria-label",
      contentT("content.multimodalMedia.removeTitle", { name: item.name }),
    );
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      removePendingMultimodalMedia(item.id);
      renderMultimodalMediaTray();
    });
    chip.append(remove);

    list.append(chip);
  }
  multimodalMediaTrayEl.append(list);
  if (multimodalMediaStatusEl && hasVisibleStatus) {
    multimodalMediaTrayEl.append(multimodalMediaStatusEl);
  }
}

async function addPendingMultimodalFiles(
  files: readonly File[],
  source: "picker" | "paste",
) {
  if (!multimodalMediaInputEnabled) return;
  const mediaFiles = files.filter(
    (file) => classifyMultimodalFile(file) !== null,
  );
  if (mediaFiles.length === 0) return;

  const existing = getCurrentRoutePendingMultimodalMedia().length;
  if (existing + mediaFiles.length > MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN) {
    setMultimodalMediaStatus(
      contentT("content.multimodalMedia.tooMany", {
        count: MULTIMODAL_MEDIA_MAX_ITEMS_PER_TURN,
      }),
      "error",
    );
    return;
  }

  let addedCount = 0;
  let hasValidationError = false;
  for (const file of mediaFiles) {
    const kind = classifyMultimodalFile(file);
    if (!kind) continue;
    const error = validateMultimodalFile(file, kind);
    if (error) {
      hasValidationError = true;
      setMultimodalMediaStatus(error, "error");
      continue;
    }
    const id = crypto.randomUUID();
    const objectUrl = kind === "image" ? URL.createObjectURL(file) : null;
    pendingMultimodalMedia.set(id, {
      id,
      kind,
      file,
      name:
        file.name ||
        (source === "paste"
          ? contentT("content.multimodalMedia.pastedFileName")
          : "media"),
      mimeType: file.type,
      sizeBytes: file.size,
      objectUrl,
      routeKey: getTokenSpeedRouteKey(),
      createdAt: Date.now(),
    });
    addedCount++;
  }

  if (addedCount > 0 && !hasValidationError) {
    clearMultimodalMediaStatus();
  } else {
    renderMultimodalMediaTray();
  }
}

function handleMultimodalMediaPaste(event: ClipboardEvent) {
  if (!multimodalMediaInputEnabled) return;
  if (!isPromptPasteTarget(event.target)) return;
  const files = extractMultimodalFilesFromDataTransfer(event.clipboardData);
  if (files.length === 0) return;

  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text) insertPromptText(text);
  void addPendingMultimodalFiles(files, "paste");
}

function extractMultimodalFilesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];

  const directFiles = dedupeClipboardMultimodalFiles(
    Array.from(dataTransfer.files ?? []),
  );
  if (directFiles.length > 0) return directFiles;

  return dedupeClipboardMultimodalFiles(
    Array.from(dataTransfer.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()),
  );
}

function dedupeClipboardMultimodalFiles(
  candidates: Array<File | null>,
): File[] {
  const files: File[] = [];
  const seen = new Set<string>();
  const addFile = (file: File | null) => {
    if (!file || !classifyMultimodalFile(file)) return;
    const key = `${file.name}\0${file.type}\0${file.size}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  for (const file of candidates) {
    addFile(file);
  }
  return files;
}

function isPromptPasteTarget(target: EventTarget | null): boolean {
  const textarea = getPromptTextarea();
  if (!textarea || !(target instanceof Node)) return false;
  if (target === textarea) return true;
  return Boolean(findDeepSeekInputBox()?.contains(target));
}

function insertPromptText(text: string) {
  return insertTextIntoPromptTextarea(text, getPromptTextarea());
}

async function consumePendingMultimodalMediaForRequest(
  body: Readonly<DeepSeekRequestBody>,
  options: { onLongRunning?: (timeoutMs: number) => void } = {},
): Promise<DeepSeekRequestBody> {
  if (!multimodalMediaInputEnabled) {
    clearPendingMultimodalMedia();
    return { ...body };
  }

  const mediaRouteKey = selectPendingMultimodalMediaRouteKey(body);
  if (!mediaRouteKey) return { ...body };

  const media = getPendingMultimodalMediaForRoute(mediaRouteKey);
  if (media.length === 0) return { ...body };

  const originalPrompt = body.prompt;
  if (!originalPrompt.trim()) {
    throw new Error(contentT("content.multimodalMedia.emptyPrompt"));
  }
  options.onLongRunning?.(
    calculateMultimodalRequestAugmentationTimeoutMs(media),
  );

  try {
    multimodalMediaBusy = true;
    renderMultimodalMediaTray();
    setMultimodalMediaStatus(
      contentT("content.multimodalMedia.analyzing", { count: media.length }),
      "info",
    );

    const inputs = await Promise.all(
      media.map(readPendingMultimodalMediaInput),
    );
    const response =
      await sendRuntimeMessageStrict<MultimodalMediaAnalyzeResponse>({
        type: "ANALYZE_MULTIMODAL_MEDIA",
        payload: {
          prompt: originalPrompt,
          media: inputs,
          chatSessionId:
            typeof body.chat_session_id === "string"
              ? body.chat_session_id
              : getCurrentChatSessionId(),
          parentMessageId: normalizeContentMessageId(body.parent_message_id),
        },
      });
    if (!response.ok)
      throw new Error(response.error || "Multimodal analysis failed.");

    clearPendingMultimodalMediaItems(media);
    setMultimodalMediaStatus(
      contentT("content.multimodalMedia.analyzed", {
        count: response.analyses.length,
      }),
      "info",
    );
    return {
      ...body,
      prompt: buildMultimodalAnalysisPrompt(originalPrompt, response.analyses),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMultimodalMediaStatus(
      contentT("content.multimodalMedia.failed", { message }),
      "error",
    );
    throw error;
  } finally {
    multimodalMediaBusy = false;
    renderMultimodalMediaTray();
  }
}

async function readPendingMultimodalMediaInput(
  item: PendingMultimodalMedia,
): Promise<MultimodalMediaInput> {
  if (item.kind === "image") {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      dataUrl: await readFileAsDataUrl(item.file),
    };
  }

  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    base64Data: await readFileAsBase64(item.file),
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`Failed to read ${file.name || "media file"}.`));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`Failed to read ${file.name || "media file"}.`));
    };
    reader.readAsDataURL(file);
  });
}

async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function classifyMultimodalFile(file: File): MultimodalMediaKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function validateMultimodalFile(
  file: File,
  kind: MultimodalMediaKind,
): string | null {
  if (!file.type)
    return contentT("content.multimodalMedia.unsupported", {
      name: file.name || "media",
    });
  const maxBytes =
    kind === "image"
      ? MULTIMODAL_MEDIA_IMAGE_MAX_BYTES
      : MULTIMODAL_MEDIA_VIDEO_INLINE_MAX_BYTES;
  if (file.size > maxBytes) {
    return contentT(
      kind === "image"
        ? "content.multimodalMedia.imageTooLarge"
        : "content.multimodalMedia.videoTooLarge",
      {
        name: file.name || "media",
        limit: formatMultimodalMediaBytes(maxBytes),
      },
    );
  }
  return null;
}

function getCurrentRoutePendingMultimodalMedia(): PendingMultimodalMedia[] {
  return getPendingMultimodalMediaForRoute(getTokenSpeedRouteKey());
}

function getPendingMultimodalMediaForRoute(
  routeKey: string,
): PendingMultimodalMedia[] {
  return Array.from(pendingMultimodalMedia.values())
    .filter((item) => item.routeKey === routeKey)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function selectPendingMultimodalMediaRouteKey(
  body: Record<string, unknown>,
): string | null {
  return selectMultimodalMediaRouteKeyForRequest(
    Array.from(pendingMultimodalMedia.values()),
    getTokenSpeedRouteKey(),
    { parentMessageId: normalizeContentMessageId(body.parent_message_id) },
  );
}

function handleMultimodalMediaRouteChange(
  previousRouteKey: string,
  nextRouteKey: string,
) {
  if (
    shouldPreserveInitialMultimodalMediaRoute(previousRouteKey, nextRouteKey)
  ) {
    renderMultimodalMediaTray();
    return;
  }
  if (
    hasDeepSeekChatSessionRoute(previousRouteKey) &&
    !hasDeepSeekChatSessionRoute(nextRouteKey)
  ) {
    clearPendingMultimodalMedia();
    renderMultimodalMediaTray();
    return;
  }
  clearInactiveMultimodalMedia(nextRouteKey);
}

function clearInactiveMultimodalMedia(routeKey: string) {
  for (const item of Array.from(pendingMultimodalMedia.values())) {
    if (item.routeKey !== routeKey) removePendingMultimodalMedia(item.id);
  }
  renderMultimodalMediaTray();
}

function clearPendingMultimodalMediaItems(
  items: readonly PendingMultimodalMedia[],
) {
  for (const item of items) removePendingMultimodalMedia(item.id);
  renderMultimodalMediaTray();
}

function clearPendingMultimodalMedia() {
  for (const item of Array.from(pendingMultimodalMedia.values())) {
    removePendingMultimodalMedia(item.id);
  }
}

function removePendingMultimodalMedia(id: string) {
  const item = pendingMultimodalMedia.get(id);
  if (!item) return;
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  pendingMultimodalMedia.delete(id);
}

function setMultimodalMediaStatus(message: string, tone: "info" | "error") {
  if (!multimodalMediaStatusEl) return;
  multimodalMediaStatusEl.textContent = message;
  multimodalMediaStatusEl.dataset.tone = tone;
  renderMultimodalMediaTray();
}

function clearMultimodalMediaStatus() {
  if (!multimodalMediaStatusEl) return;
  multimodalMediaStatusEl.textContent = "";
  delete multimodalMediaStatusEl.dataset.tone;
  renderMultimodalMediaTray();
}

function normalizeContentMessageId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatMultimodalMediaBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function createMultimodalMediaButtonIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" />
      <path d="m8 15 2.4-2.4a1.2 1.2 0 0 1 1.7 0L15 15.5l1-1a1 1 0 0 1 1.4 0L20 17" />
      <path d="M8.5 9.5h.01" />
      <path d="M16 4v4" />
      <path d="M14 6h4" />
    </svg>
  `;
}

function injectMultimodalMediaStyles() {
  if (document.getElementById(MULTIMODAL_MEDIA_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = MULTIMODAL_MEDIA_STYLE_ID;
  style.textContent = `
    [data-dpp-multimodal-media-anchor] {
      position: relative !important;
    }

    .dpp-mm-file-input {
      display: none !important;
    }

    .dpp-mm-button {
      position: absolute;
      right: 64px;
      bottom: 18px;
      z-index: 35;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 999px;
      background: rgba(238, 243, 255, 0.94);
      color: #4d6bfe;
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      transition: background 120ms ease, color 120ms ease, transform 120ms ease, opacity 120ms ease;
    }

    [data-dpp-multimodal-media-has-native="true"] .dpp-mm-button {
      right: 102px;
    }

    .dpp-mm-button:hover {
      background: rgba(224, 233, 255, 0.98);
      transform: translateY(-1px);
    }

    .dpp-mm-button:disabled {
      cursor: wait;
      opacity: 0.62;
      transform: none;
    }

    .dpp-mm-button svg {
      width: 19px;
      height: 19px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .dpp-mm-tray {
      all: initial;
      box-sizing: border-box;
      position: relative;
      z-index: 34;
      display: none;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      width: 100%;
      max-width: 100%;
      margin: 0 0 8px 0;
      padding: 0 14px;
      overflow: visible;
      color: #1f2937;
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
    }

    .dpp-mm-tray[data-visible="true"] {
      display: flex;
    }

    .dpp-mm-list {
      all: initial;
      box-sizing: border-box;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(160px, 220px);
      align-items: center;
      gap: 8px;
      width: 100%;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0 2px 4px 2px;
      scrollbar-width: thin;
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
    }

    .dpp-mm-chip {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      max-width: 210px;
      height: 36px;
      flex: 0 0 auto;
      padding: 4px 6px 4px 4px;
      border: 1px solid rgba(77, 107, 254, 0.18);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.92);
      color: #1f2937;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    .dpp-mm-preview {
      box-sizing: border-box;
      display: block;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      border-radius: 6px;
      object-fit: cover;
      background: #eef3ff;
    }

    .dpp-mm-preview-file {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #4d6bfe;
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
    }

    .dpp-mm-name {
      box-sizing: border-box;
      min-width: 0;
      overflow: hidden;
      color: inherit;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dpp-mm-remove {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #6b7280;
      cursor: pointer;
      font: 600 16px/1 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
    }

    .dpp-mm-remove:hover {
      background: rgba(15, 23, 42, 0.08);
      color: #111827;
    }

    .dpp-mm-status {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: min(100%, 280px);
      height: 24px;
      flex: 0 0 auto;
      padding: 0 8px;
      border-radius: 999px;
      background: rgba(238, 243, 255, 0.78);
      overflow: hidden;
      color: #4b5563;
      font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }

    .dpp-mm-status:empty {
      display: none;
    }

    .dpp-mm-status[data-tone="error"] {
      color: var(--dpp-ui-error, #b42318);
    }

    body.dpp-theme-dark .dpp-mm-button {
      background: rgba(48, 56, 82, 0.9);
      color: var(--dpp-ui-accent, #9fb2ff);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.26);
    }

    body.dpp-theme-dark .dpp-mm-button:hover {
      background: rgba(61, 72, 105, 0.96);
    }

    body.dpp-theme-dark .dpp-mm-chip {
      border-color: rgba(125, 145, 255, 0.24);
      background: rgba(28, 32, 44, 0.92);
      color: #e5e7eb;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.24);
    }

    body.dpp-theme-dark .dpp-mm-preview {
      background: rgba(72, 85, 130, 0.44);
    }

    body.dpp-theme-dark .dpp-mm-remove {
      color: #aab1c4;
    }

    body.dpp-theme-dark .dpp-mm-remove:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f8fafc;
    }

    body.dpp-theme-dark .dpp-mm-status {
      background: rgba(72, 85, 130, 0.32);
      color: #bac3d8;
    }

    body.dpp-theme-dark .dpp-mm-status[data-tone="error"] {
      color: var(--dpp-ui-error, #ffb4a8);
    }
  `;
  document.head.appendChild(style);
}

function downloadConversationExportArtifacts(
  artifacts: readonly ConversationExportArtifact[],
) {
  const manager = exportDownloadManager;
  if (!manager || artifacts.length === 0)
    throw new Error(contentT("content.export.failed"));
  if (artifacts.length === 1) {
    const artifact = artifacts[0];
    manager.download(
      artifact.filename,
      new Blob([artifact.content], { type: artifact.mimeType }),
    );
    return;
  }

  const archive = createConversationExportArchiveArtifact(artifacts);
  const archiveBytes = new Uint8Array(archive.content.byteLength);
  archiveBytes.set(archive.content);
  manager.download(
    archive.filename,
    new Blob([archiveBytes], { type: archive.mimeType }),
  );
}

function showConversationExportToast(
  message: string,
  tone: "info" | "success" | "warning" | "error",
) {
  let toast = document.querySelector<HTMLElement>(
    `.${EXPORT_ACTION_TOAST_CLASS}`,
  );
  if (!toast) {
    toast = document.createElement("div");
    toast.className = EXPORT_ACTION_TOAST_CLASS;
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.dataset.visible = "true";
  if (exportActionToastTimer) clearTimeout(exportActionToastTimer);
  exportActionToastTimer = setTimeout(() => {
    exportActionToastTimer = null;
    toast.dataset.visible = "false";
  }, EXPORT_ACTION_TOAST_VISIBLE_MS);
}

let contentToastTimer: ReturnType<typeof setTimeout> | null = null;
const CONTENT_TOAST_VISIBLE_MS = 6000;

/**
 * Generic status toast for content-script-initiated notices (e.g. the inline
 * agent concurrency guard in issue #298). Distinct from the export toast so
 * the two never overwrite each other.
 */
// 计划型短答案的自动续次上限：按 requestId 只续一次，避免自激。
let planOnlyContinuedRequestId = "";
// 自动续轮预算（时间窗 + 次数）。为什么不用 requestId 做闸：真机上
// complete.requestId 可能为空，"" === "" 会让「已续过」恒为 true ⇒ 续轮从不触发（实测 plan=0）。
let autoContinueBudget: { windowStart: number; count: number } = { windowStart: 0, count: 0 };

/** 点一次页面自己的发送按钮（不伪造事件，使用真实按钮）。 */
function submitComposerFromContent(): void {
  const box = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!box) return;
  let container: HTMLElement = box;
  for (let i = 0; i < 6 && container.parentElement; i += 1) {
    container = container.parentElement;
    if (container.querySelectorAll(".ds-button").length >= 2) break;
  }
  const button = container.querySelector<HTMLElement>(".ds-button--primary.ds-button--filled")
    ?? [...container.querySelectorAll<HTMLElement>(".ds-button")].pop();
  button?.click();
}

// 页面侧看门狗（2026-10-30 真机）：审计类提示词下页面 stop=true 持续 4 分钟、正文不再增长，
// 流根本没结束 ⇒ RESPONSE_COMPLETE 永不触发 ⇒ 续轮逻辑永远等不到。这里兜底"挂死"。
let stallLastLen = -1;
let stallNoticeShown = false;
let stallLastChangeAt = Date.now();
function startStallWatchdog(): void {
  setInterval(() => {
    try {
      // 必须取**最后一条** .ds-message 的正文：`:last-of-type` 按标签类型匹配，
      // 兄弟里还有别 div 时会匹配不到；退化成取第一条会让 len 恒定 ⇒ 看门狗误杀正常生成。
        const len = readLastAnswerLength(document);
      if (len !== stallLastLen) { stallLastLen = len; stallLastChangeAt = Date.now(); stallNoticeShown = false; return; }
      if (len === 0) return;
      const generating = Boolean(document.querySelector("[class*=\"stop\"]"));
      // 审计 P2-2：stall 此前只进后台诊断，页面 300s 静默。这里给一次可见提示（不打断）。
      if (shouldShowStallNotice({ now: Date.now(), lastChangeAt: stallLastChangeAt, generating, alreadyShown: stallNoticeShown })) {
        stallNoticeShown = true;
        diagnosticLogBuffer.record({
          level: "warn",
          source: "chat",
          message: "stall_notice",
          details: `idleMs=${Date.now() - stallLastChangeAt} len=${len}`,
        });
        showContentToast(contentT("content.agent.stallWaiting"), "info");
      }
      if (!decideStallRecovery({ now: Date.now(), lastChangeAt: stallLastChangeAt, generating })) return;
      diagnosticLogBuffer.record({
        level: "warn",
        source: "chat",
        message: "stall_recovery",
        details: `len=${len} idleMs=${Date.now() - stallLastChangeAt}`,
      });
      const stopButton = document.querySelector<HTMLElement>("[class*=\"stop\"]");
      stopButton?.click();
      stallLastChangeAt = Date.now();
      window.setTimeout(() => {
        const inserted = insertTextIntoPromptTextarea(contentT("content.agent.planOnlyContinuePrompt"));
        if (inserted.ok) submitComposerFromContent();
      }, 1200);
    } catch { /* 忽略 */ }
  }, 15000);
}
startStallWatchdog();

function showContentToast(
  message: string,
  tone: "info" | "warning" = "info",
): void {
  injectContentToastStyles();
  let toast = document.querySelector<HTMLElement>(`.${CONTENT_TOAST_CLASS}`);
  if (!toast) {
    toast = document.createElement("div");
    toast.className = CONTENT_TOAST_CLASS;
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.dataset.visible = "true";
  if (contentToastTimer) clearTimeout(contentToastTimer);
  contentToastTimer = setTimeout(() => {
    contentToastTimer = null;
    toast!.dataset.visible = "false";
  }, CONTENT_TOAST_VISIBLE_MS);
}

function injectContentToastStyles(): void {
  if (document.getElementById(CONTENT_TOAST_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CONTENT_TOAST_STYLE_ID;
  style.textContent = `
    .${CONTENT_TOAST_CLASS} {
      position: fixed;
      left: 50%;
      bottom: 88px;
      transform: translate(-50%, 12px);
      transform-origin: center bottom;
      max-width: min(520px, calc(100vw - 32px));
      padding: 10px 16px;
      border-radius: 10px;
      background: rgba(30, 32, 40, 0.95);
      color: #fff;
      font-size: 13px;
      line-height: 1.45;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
      z-index: 2147483646;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    .${CONTENT_TOAST_CLASS}[data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .${CONTENT_TOAST_CLASS}[data-tone="warning"] {
      background: rgba(180, 110, 0, 0.96);
    }
  `;
  document.head.appendChild(style);
}

function isVisibleElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0
  );
}

function createConversationExportActionIcon(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 21h14"></path>
    </svg>
  `;
}

function injectConversationExportActionStyles() {
  if (document.getElementById(EXPORT_ACTION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = EXPORT_ACTION_STYLE_ID;
  style.textContent = `
    .${EXPORT_ACTION_CLASS} {
      display: inline-flex;
      flex: 0 0 28px;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #8a8f99;
      cursor: pointer;
      vertical-align: middle;
      transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
    }
    .${EXPORT_ACTION_CLASS}:hover {
      color: #4d6bfe;
      background: rgba(77, 107, 254, 0.09);
    }
    .${EXPORT_ACTION_CLASS}:disabled {
      cursor: default;
      opacity: 0.68;
    }
    .${EXPORT_ACTION_CLASS}[data-status="running"] svg {
      animation: dpp-export-pulse 0.9s ease-in-out infinite;
    }
    .${EXPORT_ACTION_CLASS} svg {
      width: 18px;
      height: 18px;
      pointer-events: none;
    }
    .${EXPORT_ACTION_MENU_CLASS} {
      position: fixed;
      z-index: 2147483647;
      min-width: 176px;
      box-sizing: border-box;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 10px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.98);
      box-shadow: 0 16px 38px rgba(15, 23, 42, 0.18);
      color: #111827;
      font-size: 13px;
      line-height: 1.35;
    }
    .${EXPORT_ACTION_MENU_CLASS} form {
      margin: 0;
    }
    .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-title {
      margin: 0 0 8px;
      color: #475569;
      font-size: 12px;
      font-weight: 600;
    }
    .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-option {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      border-radius: 7px;
      padding: 4px 6px;
      cursor: pointer;
      user-select: none;
    }
    .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-option:hover {
      background: rgba(77, 107, 254, 0.08);
    }
    .${EXPORT_ACTION_MENU_CLASS} input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #4d6bfe;
    }
    .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(15, 23, 42, 0.08);
    }
    .${EXPORT_ACTION_MENU_CLASS} button {
      min-width: 48px;
      height: 28px;
      border: 0;
      border-radius: 7px;
      padding: 0 10px;
      font: inherit;
      cursor: pointer;
    }
    .${EXPORT_ACTION_MENU_CLASS} button[type="button"] {
      background: transparent;
      color: #64748b;
    }
    .${EXPORT_ACTION_MENU_CLASS} button[type="submit"] {
      background: #4d6bfe;
      color: #ffffff;
    }
    .${EXPORT_ACTION_MENU_CLASS} button:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .${EXPORT_ACTION_TOAST_CLASS} {
      position: fixed;
      left: 50%;
      bottom: 104px;
      z-index: 2147483647;
      max-width: min(420px, calc(100vw - 32px));
      transform: translate(-50%, 10px);
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 10px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
      color: #111827;
      font-size: 13px;
      line-height: 1.45;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.16s ease, transform 0.16s ease;
    }
    .${EXPORT_ACTION_TOAST_CLASS}[data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .${EXPORT_ACTION_TOAST_CLASS}[data-tone="success"] {
      border-color: rgba(34, 197, 94, 0.28);
    }
    .${EXPORT_ACTION_TOAST_CLASS}[data-tone="warning"] {
      border-color: rgba(245, 158, 11, 0.34);
    }
    .${EXPORT_ACTION_TOAST_CLASS}[data-tone="error"] {
      border-color: rgba(239, 68, 68, 0.34);
      color: #b91c1c;
    }
    @media (prefers-color-scheme: dark) {
      .${EXPORT_ACTION_MENU_CLASS} {
        border-color: rgba(255, 255, 255, 0.12);
        background: rgba(31, 41, 55, 0.98);
        color: #f9fafb;
        box-shadow: 0 16px 38px rgba(0, 0, 0, 0.38);
      }
      .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-title,
      .${EXPORT_ACTION_MENU_CLASS} button[type="button"] {
        color: #cbd5e1;
      }
      .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-option:hover {
        background: rgba(96, 165, 250, 0.14);
      }
      .${EXPORT_ACTION_MENU_CLASS} .dpp-export-menu-actions {
        border-top-color: rgba(255, 255, 255, 0.1);
      }
      .${EXPORT_ACTION_TOAST_CLASS} {
        border-color: rgba(255, 255, 255, 0.14);
        background: rgba(31, 41, 55, 0.96);
        color: #f9fafb;
      }
      .${EXPORT_ACTION_TOAST_CLASS}[data-tone="error"] {
        color: #fca5a5;
      }
    }
    @keyframes dpp-export-pulse {
      0%, 100% { transform: translateY(0); opacity: 1; }
      50% { transform: translateY(1px); opacity: 0.62; }
    }
  `;
  document.head.appendChild(style);
}

function normalizeCapturedClientHeaders(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== "object") return null;
  const headers = value as Record<string, unknown>;
  const authorization = headers.Authorization;
  if (typeof authorization !== "string" || !authorization) return null;

  const normalized: Record<string, string> = { Authorization: authorization };
  for (const [key, entry] of Object.entries(headers)) {
    if (key === "Authorization") continue;
    if (typeof entry === "string" && entry) normalized[key] = entry;
  }
  return normalized;
}

async function sendRuntimeMessage<T>(message: unknown): Promise<T | undefined> {
  if (!hasLiveExtensionContext()) return undefined;

  try {
    const result = await sendMessageWithReceiverRetry(() =>
      chrome.runtime.sendMessage(message),
    );
    // Guard against background error responses being misinterpreted as valid data
    if (isRuntimeFailure(result)) {
      return undefined;
    }
    return result as T;
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
      return undefined;
    }
    return undefined;
  }
}

async function sendRuntimeMessageStrict<T>(
  message: unknown,
  decode?: (value: unknown) => T,
): Promise<T> {
  if (!hasLiveExtensionContext()) {
    throw new Error("Extension context is unavailable.");
  }

  return sendMessageWithReceiverRetry(async () => {
    const result = await chrome.runtime.sendMessage(message);
    if (decode) {
      return decodeRuntimeResponse(result, decode, "Runtime request failed.");
    }
    if (isRuntimeFailure(result)) {
      throw new Error(
        result.error ? String(result.error) : "Runtime request failed.",
      );
    }
    return result as T;
  });
}

// MV3 wake race: a reclaimed service worker answers the first message with
// "Receiving end does not exist" because its listener is not registered yet.
// That rejection means the message was never delivered and no handler ran, so
// retrying the send is safe; without it every cold start reads as a hard
// failure and the page loses memories, skills, tools and MCP config.
async function sendMessageWithReceiverRetry<T>(
  send: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < RUNTIME_RECEIVER_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (isExtensionInvalidatedError(error)) {
        invalidateExtensionContext();
        throw error;
      }
      if (!isMissingRuntimeReceiverError(error)) throw error;

      lastError = error;
      if (attempt === RUNTIME_RECEIVER_RETRY_MAX_ATTEMPTS - 1) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            RUNTIME_RECEIVER_RETRY_BASE_MS * 2 ** attempt,
            RUNTIME_RECEIVER_RETRY_MAX_MS,
          ),
        ),
      );
      if (!hasLiveExtensionContext()) throw error;
    }
  }

  throw lastError;
}

function isMissingRuntimeReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection")
  );
}

function addRuntimeMessageListener(
  listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0],
): () => void {
  if (!hasLiveExtensionContext()) return () => undefined;

  try {
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
    }
    return () => undefined;
  }
}

function startDeepSeekThemeSync() {
  syncDeepSeekTheme();

  themeObserver?.disconnect();
  themeObserver = new MutationObserver(scheduleDeepSeekThemeSync);
  observeThemeHost(document.documentElement);
  observeThemeHost(document.body);
  observeThemeHost(document.getElementById("root"));

  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  themeMediaListener = () => scheduleDeepSeekThemeSync();
  themeMediaQuery.addEventListener("change", themeMediaListener);

  startThemeBootstrapSync();
}

function stopDeepSeekThemeSync() {
  themeObserver?.disconnect();
  themeObserver = null;
  stopThemeBootstrapSync();
  if (themeSyncTimer) {
    clearTimeout(themeSyncTimer);
    themeSyncTimer = null;
  }
  if (themeMediaQuery && themeMediaListener) {
    themeMediaQuery.removeEventListener("change", themeMediaListener);
  }
  themeMediaQuery = null;
  themeMediaListener = null;
}

function startThemeBootstrapSync() {
  stopThemeBootstrapSync();
  themeBootstrapAttempts = 0;
  themeTreeObserver = new MutationObserver(() => {
    observeThemeTree(document.getElementById("root"));
    scheduleDeepSeekThemeSync();
  });

  observeThemeTree(document.body);
  observeThemeTree(document.getElementById("root"));
  scheduleThemeBootstrapRetry();
}

function stopThemeBootstrapSync() {
  themeTreeObserver?.disconnect();
  themeTreeObserver = null;
  if (themeBootstrapTimer) {
    clearTimeout(themeBootstrapTimer);
    themeBootstrapTimer = null;
  }
}

function observeThemeHost(element: Element | null) {
  if (!element || !themeObserver) return;
  themeObserver.observe(element, {
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "data-theme",
      "data-color-mode",
      "data-mode",
      "color-scheme",
      "data-ds-dark-theme",
    ],
  });
}

function observeThemeTree(element: Element | null) {
  if (!element || !themeTreeObserver) return;
  themeTreeObserver.observe(element, { childList: true, subtree: true });
}

function scheduleThemeBootstrapRetry() {
  if (themeBootstrapTimer) return;
  themeBootstrapTimer = setTimeout(() => {
    themeBootstrapTimer = null;
    themeBootstrapAttempts += 1;
    syncDeepSeekTheme();

    if (themeBootstrapAttempts >= THEME_BOOTSTRAP_RETRY_LIMIT) {
      stopThemeBootstrapSync();
      return;
    }
    scheduleThemeBootstrapRetry();
  }, THEME_BOOTSTRAP_RETRY_MS);
}

function scheduleDeepSeekThemeSync() {
  if (themeSyncTimer) clearTimeout(themeSyncTimer);
  themeSyncTimer = setTimeout(() => {
    themeSyncTimer = null;
    syncDeepSeekTheme();
  }, 50);
}

function syncDeepSeekTheme() {
  const theme = detectDeepSeekTheme();
  applyDeepSeekThemeClass(theme);
  if (theme === currentDeepSeekTheme) return;
  currentDeepSeekTheme = theme;
  void sendRuntimeMessage({ type: "SET_DEEPSEEK_THEME", payload: { theme } });
}

function applyDeepSeekThemeClass(theme: DeepSeekTheme) {
  document.body.classList.toggle("dpp-theme-dark", theme === "dark");
  document.body.classList.toggle("dpp-theme-light", theme === "light");
}

function detectDeepSeekTheme(): DeepSeekTheme {
  return (
    detectExplicitTheme() ??
    detectBackgroundTheme() ??
    (window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light")
  );
}

function detectExplicitTheme(): DeepSeekTheme | null {
  const hosts = [
    document.documentElement,
    document.body,
    document.getElementById("root"),
  ].filter((element): element is HTMLElement => Boolean(element));
  const attributeNames = [
    "data-theme",
    "data-color-mode",
    "data-mode",
    "color-scheme",
  ];

  for (const host of hosts) {
    // DeepSeek toggles its theme with a boolean `data-ds-dark-theme` marker;
    // honor it directly so injected UI follows the host instead of the OS
    // prefers-color-scheme (Issue #551).
    if (host.hasAttribute("data-ds-dark-theme")) return "dark";
    for (const name of attributeNames) {
      const theme = parseThemeText(host.getAttribute(name));
      if (theme) return theme;
    }

    const themeFromClass = parseThemeText(
      typeof host.className === "string" ? host.className : "",
    );
    if (themeFromClass) return themeFromClass;

    const scheme = getComputedStyle(host).colorScheme.toLowerCase().trim();
    if (scheme === "dark" || scheme === "light") return scheme;
  }

  return null;
}

function parseThemeText(value: string | null): DeepSeekTheme | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/(^|[\s_-])(dark|black|night)([\s_-]|$)/.test(normalized)) return "dark";
  if (/(^|[\s_-])(light|white|day)([\s_-]|$)/.test(normalized)) return "light";
  return null;
}

function detectBackgroundTheme(): DeepSeekTheme | null {
  const sampled = document.elementFromPoint(
    Math.max(0, Math.floor(window.innerWidth / 2)),
    Math.max(0, Math.min(Math.floor(window.innerHeight / 2), 240)),
  );
  const candidates = [
    sampled,
    document.querySelector("main"),
    document.getElementById("root"),
    document.body,
    document.documentElement,
  ].filter((element): element is Element => Boolean(element));

  for (const candidate of candidates) {
    let element: Element | null = candidate;
    while (element && element !== document.documentElement.parentElement) {
      const theme = themeFromBackgroundColor(
        getComputedStyle(element).backgroundColor,
      );
      if (theme) return theme;
      element = element.parentElement;
    }
  }

  return null;
}

function themeFromBackgroundColor(color: string): DeepSeekTheme | null {
  const rgb = parseRgbColor(color);
  if (!rgb || rgb.alpha < 0.2) return null;
  return relativeLuminance(rgb.red, rgb.green, rgb.blue) < 0.45
    ? "dark"
    : "light";
}

function parseRgbColor(
  color: string,
): { red: number; green: number; blue: number; alpha: number } | null {
  const match = color.match(/^rgba?\((.+)\)$/);
  if (!match) return null;

  const parts = match[1]
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const [red, green, blue] = parts.slice(0, 3).map(Number);
  const alpha = parts[3] === undefined ? 1 : Number(parts[3]);
  if ([red, green, blue, alpha].some((part) => Number.isNaN(part))) return null;
  return { red, green, blue, alpha };
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function startInlineAgentIfNeeded(
  complete: ResponseCompletePayload,
  executions: ToolExecutionRecord[],
): Promise<void> {
  if (isInlineAgentResponseComplete(complete)) {
    console.log('[DPP-AUTO] skip: inline agent continuation response');
    recordAgentStartDecision('skipped:continuation_response', 'complete 被判定为本循环自己发起的续轮响应');
    return;
  }

  // Concurrency guard (issue #298): if an inline agent loop is already running
  // for this conversation, do NOT start a second one off a user-initiated turn
  // (e.g. a "continue" prompt because the long-running agent looked stuck).
  // Starting a second loop previously left two agent panels racing in the DOM.
  // Continuation turns are produced by the agent loop itself and are already
  // handled by isInlineAgentResponseComplete above.
  if (isInlineAgentRunning()) {
    console.log('[DPP-AUTO] concurrency: inline agent already running, showing confirm dialog');
    recordAgentStartDecision('skipped:already_running', '已有 inline agent 在跑，弹并发确认框');
    const shouldInterrupt = await showAgentConcurrencyConfirm();
    if (!shouldInterrupt) {
      console.log('[DPP-AUTO] concurrency: user cancelled, skipping new loop');
      recordAgentStartDecision('skipped:user_cancelled_concurrency', '用户在并发确认框里选择不中断');
      return;
    }
    console.log('[DPP-AUTO] concurrency: user confirmed, stopping old loop and starting new one');
    stopInlineAgent();
  }

  // Collect executions that should trigger a continuation.
  // Single authority in execution-policy.ts: default-continue, explicit exclude.
  const continuableExecutions = selectContinuableToolExecutions(executions);
  // User explicitly asked to continue (e.g. "继续完成", "continue") — even
  // without tool executions, we should start the agent loop so the model can
  // resume the interrupted task. Without this, pure-text interruptions after
  // a user "continue" prompt were silently skipped (断流 root cause).
  const userAskedToContinue = USER_CONTINUATION_RE.test(complete.originalPrompt);
  if (continuableExecutions.length === 0 && !userAskedToContinue) {
    console.log('[DPP-AUTO] skip: no continuable executions', {
      total: executions.length,
      tools: executions.map(e => ({ name: e.name, providerKind: e.provider?.kind })),
    });
    // 这是最可能的早退分支：工具执行了但没被算作「可续跑」。
    recordAgentStartDecision(
      'skipped:no_continuable_executions',
      `executions=${executions.length} continuable=0 userAskedToContinue=false names=${executions.map(e => e.name).join(',') || '(none)'}`,
    );
    return;
  }
  if (userAskedToContinue && continuableExecutions.length === 0) {
    console.log('[DPP-AUTO] user continuation prompt detected, starting agent loop without prior tool executions');
  }
  // T2-1: a brand-new chat's first request carries no chat_session_id — the
  // browser-owned route /chat/s/<id> appears only after the server creates the
  // session, so the request body has chatSessionId === null. Previously this
  // guard silently returned (console.log only), so the continuation loop never
  // started after a successful first-turn tool call. Reuse the tool-binding
  // layer's bounded wait for the SPA route instead of abandoning the turn.
  let resolvedChatSessionId = complete.chatSessionId;
  if (!resolvedChatSessionId) {
    resolvedChatSessionId = await waitForBrowserOwnedChatSession({
      readChatSessionId: getCurrentChatSessionId,
      timeoutMs: TOOL_SESSION_BINDING_TIMEOUT_MS,
    });
  }
  // T2-1 / T2-3: never fail silently. If the route never appears or the server
  // never sent an assistant message id, show a visible warning instead of a
  // console.log-only return.
  const sessionId = resolvedChatSessionId;
  if (!sessionId || complete.assistantMessageId == null) {
    showContentToast(contentT("content.agent.startFailed"), "warning");
    return;
  }
  const assistantId = complete.assistantMessageId;
  complete = { ...complete, chatSessionId: sessionId };

  const loopId = crypto.randomUUID();
  const authorization = complete.requestId
    ? activeToolAuthorizations.get(complete.requestId)
    : undefined;
  if (!authorization) {
    console.log('[DPP-AUTO] skip: no authorization for requestId', {
      requestId: complete.requestId,
      knownAuthIds: [...activeToolAuthorizations.keys()],
    });
    // Don't fail silently: the user asked for agent work and the loop cannot
    // start without the tool authorization grant (Issue #544).
    showContentToast(contentT("content.agent.startFailed"), "warning");
    return;
  }

  // M0 G2：此处已通过全部 guard、确认 loop 真正启动。用户主动 continue 优先记 user_continued，
  // 否则记 model_requested（模型留了可续执行）。单一事件 + reason 分组，避免双计数。
  refactorTelemetry.recordHarnessEvent({
    type: 'continuation_triggered',
    turnId: loopId,
    reason: userAskedToContinue ? 'user_continued' : 'model_requested',
    timestamp: Date.now(),
  });

  console.log('[DPP-AUTO] starting inline agent loop', {
    loopId,
    requestId: complete.requestId,
    continuableTools: continuableExecutions.map(e => e.name),
  });

  const payload: InlineAgentStartPayload = {
    loopId,
    capabilityScopeRequestId: complete.requestId,
    chatSessionId: sessionId,
    parentMessageId: assistantId,
    originalPrompt: complete.agentTaskPrompt || complete.originalPrompt,
    agentTaskPrompt: complete.agentTaskPrompt || complete.originalPrompt,
    toolExecutions: continuableExecutions,
    promptOptions: {
      modelType: complete.promptOptions.modelType,
      searchEnabled: complete.promptOptions.searchEnabled,
      thinkingEnabled: complete.promptOptions.thinkingEnabled,
      refFileIds: complete.promptOptions.refFileIds,
    },
    toolDescriptors: filterContinuableToolDescriptors(authorization.descriptors),
    locale: currentContentLocale,
    powWasmUrl: chrome.runtime.getURL(DEEPSEEK_POW_WASM_PATH),
  };

  injectInlineAgentStyles();
  const container = createAgentContainer(
    stopInlineAgent,
    getAgentRendererLabels(),
  );
  container.setAttribute("data-dpp-agent-loop-id", loopId);

  const anchorContent = getInlineAgentAnchorContent(complete);
  const scope = inlineAgentCapabilityScope;
  // 2026-10-22：观测根改用 document.documentElement，而不是捕获一次的 #root。
  // 原实现捕获 `document.getElementById("root")`，若 React 之后替换/卸载该节点
  // （SPA 导航、hydration 重建），观察者就挂在一个已脱离文档的节点上，永远收不到
  //  MutationRecord —— 真机表现就是 find() 只跑两次、然后直到超时。
  // documentElement 在文档生命周期内稳定，subtree 覆盖整棵 light DOM。
  const observationRoot = document.documentElement ?? document.body;
  if (!scope?.active || !observationRoot) {
    showContentToast(contentT("content.agent.startFailed"), "warning");
    return;
  }
  // 新的等待窗开始：重置限流时间戳，保证 waitForInlineAgentLiveTarget 的
  // 第一次同步 find() 一定执行。若沿用上一次的 lastFindScanAt，
  // 「锚点其实已经在了」的情况可能被限流跳过而误判成等不到。
  const runAnchorWait = (timeoutMs: number) => {
    lastFindScanAt = 0;
    return waitForInlineAgentLiveTarget({
      find() {
        // 2026-10-22 性能护栏：观测根改成 document.documentElement 之后，
        // childList+subtree 会收到整页每一次 DOM 变更（DeepSeek 流式输出时
        // 每秒几十次）。而 find() 里的 getAssistantMessages() 是全 DOM 扫描 +
        // 过滤，等待窗里可能跑几百次。
        //
        // 用「距上次完整扫描至少间隔 MIN_FIND_SCAN_INTERVAL_MS」限流，而不是用
        // 「.ds-message 数量没变就跳过」——后者会漏掉「数量不变但同一条消息内部
        // 才刚渲染出锚点文本」的情况（虚拟列表会先挂容器再填内容）。
        const now = Date.now();
        if (now - lastFindScanAt < MIN_FIND_SCAN_INTERVAL_MS) return null;
        lastFindScanAt = now;

        const messages = getAssistantMessages();
        const target = findInlineAgentLiveTarget(
          complete,
          messages,
          anchorContent,
        );
        // 2026-10-21 观测：真机 located=false 且放到 15s 也没用，
        // 但手动在页面上跑同一套逻辑又能找到助手消息。
        // 这里把每次 find() 看到的数量打出来（限流 20 次，覆盖整个等待窗），
        // 直接区分「find() 看不到消息」与「看得到但匹配不上」。
        if (anchorFindProbeCount < 20) {
          anchorFindProbeCount += 1;
          const probeRoot = document.getElementById('root');
          recordAgentStartDecision(
            'anchor_find_probe',
            `n=${anchorFindProbeCount} messages=${messages.length} anchorLen=${anchorContent.length} `
            + `dsMessage=${document.querySelectorAll('.ds-message').length} `
            + `contentHosts=${document.querySelectorAll(ASSISTANT_RESPONSE_CONTENT_SELECTOR).length} `
            // 区分「detached 文档」与「frame 不对」的关键量：
            // detached → root 存在但 isConnected=false；
            // frame 不对 → location.href 不是 chat.deepseek.com。
            + `rootPresent=${Boolean(probeRoot)} rootConnected=${probeRoot?.isConnected ?? 'n/a'} `
            + `docChildren=${document.documentElement.childElementCount} `
            + `href=${String(location.href).slice(0, 48)} `
            + `obsRootConnected=${observationRoot.isConnected} `
            + `waitMs=${timeoutMs}`,
          );
        }
        return target ? { target, messages } : null;
      },
      observe(onMutation) {
        const observer = new MutationObserver(onMutation);
        const release = scope.observe(observer, observationRoot, {
          childList: true,
          subtree: true,
        });
        return () => {
          void release();
        };
      },
      scheduleTimeout: (callback, delayMs) => scope.setTimeout(callback, delayMs),
      clearScheduledTimeout: (timer) => scope.clearTimeout(timer),
      signal: scope.signal,
      timeoutMs,
    });
  };

  let located = await runAnchorWait(INLINE_AGENT_LIVE_TARGET_WAIT_MS);

  // 2026-10-22 真机定位：DeepSeek 新建/刷新对话后要 30–90 秒才渲染出消息，
  // 15 秒快速窗必然超时。但那时 DOM 里确实什么都没有 —— 这不是「失败」，
  // 是「页面还没画完」。所以先探测页面状态：
  //   页面仍空（hasAnyMessage=false）→ 中性提示 + 延长窗继续等
  //   页面已有消息（hasAnyMessage=true）→ 才是真的锚点匹配失败
  if (!located && scope.active && inlineAgentCapabilityScope === scope) {
    const pageState = probePageRenderState();
    if (!pageState.hasAnyMessage) {
      showContentToast(contentT("content.agent.stillLoading"), "info");
      recordAgentStartDecision(
        'anchor_extended_wait',
        `visibleItems=${pageState.visibleItems} dsMessage=${pageState.dsMessage} `
        + `fastWaitMs=${INLINE_AGENT_LIVE_TARGET_WAIT_MS} extendedWaitMs=${INLINE_AGENT_EXTENDED_TARGET_WAIT_MS}`,
      );
      // Step 3（第十一批）：c8ecc5e 把失败改成了最长 135s 的静默等待，
      // 用户读成「卡死」。延长窗期间每秒刷新可见秒数；结束后给明确收尾。
      const extendedWaitStartedAt = Date.now();
      const renderTicker = window.setInterval(() => {
        const seconds = Math.max(1, Math.round((Date.now() - extendedWaitStartedAt) / 1000));
        showContentToast(contentT("content.agent.stillRendering", { seconds }), "info");
        updateAgentStatusBar("starting", {
          message: contentT("content.agent.stillRendering", { seconds }),
        });
      }, 1_000);
      // 立刻先显示 0s 档，避免第一秒完全空白
      showContentToast(contentT("content.agent.stillRendering", { seconds: 0 }), "info");
      try {
        located = await runAnchorWait(INLINE_AGENT_EXTENDED_TARGET_WAIT_MS);
      } finally {
        window.clearInterval(renderTicker);
      }
      if (located) {
        const waitedSeconds = Math.max(1, Math.round((Date.now() - extendedWaitStartedAt) / 1000));
        showContentToast(
          contentT("content.agent.stillRenderingResolved", { seconds: waitedSeconds }),
          "info",
        );
      }
    } else {
      recordAgentStartDecision(
        'anchor_missed_but_page_rendered',
        `visibleItems=${pageState.visibleItems} dsMessage=${pageState.dsMessage} `
        + `fastWaitMs=${INLINE_AGENT_LIVE_TARGET_WAIT_MS}`,
      );
    }
  }

  if (!located || inlineAgentCapabilityScope !== scope || !scope.active) {
    // Don't fail silently after the bounded DOM commit wait: the anchor
    // assistant message really could not be located (Issue #544).
    //
    // 2026-10-21 观测：这是「工具执行了但没有 trace、也没有续轮」的直接卡点。
    // 真机复现：模型调了 shell_exec（SW 诊断有 tool start/finished ok），
    // 页面弹「Agent 启动失败，请重试」，然后什么都没发生 ——
    // 因为这里在 createInlineAgentTrace / beginTraceTracking 之前就 return 了。
    // 之前只弹 toast（刷新即丢），无法区分是「没定位到锚点」「scope 失效」
    // 还是「scope 不活跃」，所以补一条持久化诊断。
    if (scope.active)
      showContentToast(contentT("content.agent.startFailed"), "warning");
    recordAgentStartDecision(
      'skipped:anchor_not_located',
      `located=${Boolean(located)} scopeMatch=${inlineAgentCapabilityScope === scope} scopeActive=${scope.active} waitMs=${INLINE_AGENT_LIVE_TARGET_WAIT_MS}`,
    );
    return;
  }
  const { target, messages } = located;
  const anchorMessageIndex = messages.indexOf(target);

  inlineAgentLoopId = loopId;
  activeInlineAgentTrace = createInlineAgentTrace(
    complete,
    loopId,
    executions,
    anchorMessageIndex,
    anchorContent,
  );
  observeReportedPersistence(writeInlineAgentTrace(activeInlineAgentTrace));
  // W29：开始采集轨迹事件（turn.start 会立即落盘）。
  // 传入原生 turn 已执行的工具，让报告里有 tool.exec 那一行。
  beginTraceTracking(loopId, executions);

  inlineAgentContainer = container;
  // Stamp the live container with its trace id so the restore dedupe check
  // (findRestoredInlineAgentTrace) recognizes it and never mounts a duplicate
  // restored console next to the still-present live one (Issue #551
  // follow-up).
  container.setAttribute("data-dpp-agent-trace-key", activeInlineAgentTrace.id);
  mountInlineAgentContainer(target, container);

  // The agent flow now owns the tool presentation of the run record: the
  // old-style collapsible tool block (and detached artifact cards) of the
  // first native turn are removed from the anchor message, and that turn's
  // executions render as the first NEW-style tool group inside the agent
  // stream — the run reads as one flow and the tool count is neither lost
  // nor duplicated. ALL completed first-turn executions are shown (not only
  // the continuable subset), matching the legacy block's coverage.
  //
  // 2026-10-23 修复（审计《工具流渲染对比报告》）：「移除旧块」曾经是**无条件**的，
  // 而「渲染新块」是**有条件**的（`stream && initialExecutions.length > 0`）。
  // 两者不配对 ⇒ `getAgentConsoleBody()` 拿不到 `.dpp-agent-stream` 时（容器结构
  // 不符 / 被页面重渲染破坏），旧块已经删掉、新块无处可建 ⇒ 助手消息下方的工具区
  // **一片空白**，而状态条仍写着「任务完成（N 步 · M 工具）」，用户看不出工具跑过。
  //
  // 现在把移除也纳入同一个条件：**只有在确实能把这一轮的 executions 渲染成
  // 新式工具组时才移除旧块**，否则保留旧块作为兜底 —— 宁可短暂重复展示，
  // 也不能两者皆无。
  const stream = getAgentConsoleBody(container);
  const initialExecutions = executions.filter(
    (execution) => !execution.pending,
  );
  if (stream) {
    removeToolBlockFromMessage(target);
  }
  if (stream && initialExecutions.length > 0) {
    // Step index -1 keeps the group ahead of every loop step: step 0's
    // narration mounts AFTER it, so the run record starts with the trigger
    // turn's tools.
    for (const exec of initialExecutions) {
      resolveAgentToolEntry(stream, -1, exec, getAgentRendererLabels());
    }
  }

  // Visible "starting" feedback for the 2.5-6.5s wait before the first model
  // turn (Issue #544); removed when the first step renders. The console
  // header carries the phase + stop control (Issue #551).
  const startingEl = createAgentStartingElement(getAgentRendererLabels());
  getAgentConsoleBody(container)?.appendChild(startingEl);
  container.setAttribute("data-agent-starting", "true");

  startAgentConsoleTimer();
  recordAgentStartDecision(
    'starting',
    `executions=${initialExecutions.length} names=${initialExecutions.map((e) => e.name).join(',') || '(none)'}`,
  );
  startOwnedInlineAgentLoop(payload);
}

function startOwnedInlineAgentLoop(payload: InlineAgentStartPayload): void {
  const task = startInlineAgentLoop(payload).catch((error) => {
    console.error("[DeepSeek++] inline agent loop failed", error);
  });
  pendingInlineAgentLoopTasks.add(task);
  void task.then(() => {
    pendingInlineAgentLoopTasks.delete(task);
  });
}

function isInlineAgentResponseComplete(
  complete: ResponseCompletePayload,
): boolean {
  return isInlineAgentContinuationRequest(
    complete.originalPrompt,
    complete.agentTaskPrompt,
  );
}

/**
 * Visually adopts the message's native DeepSeek reasoning host into the agent
 * console timeline. CSS-only (Issue #551): the host DOM is never moved, and
 * class application is idempotent so it is safe to run from the container
 * placement observer while DeepSeek streams the reasoning content in.
 */
function adoptMessageReasoningBlocks(message: Element): void {
  for (const host of getAssistantContentHosts(message)) {
    if (!looksLikeReasoningContentHost(host)) continue;
    adoptReasoningBlock(host);
    // Fold the host once its thinking finished ("Thought (N s)");
    // idempotent per host, manual expand/collapse is never overridden.
    autoCollapseCompletedReasoningHost(host);
  }
}

function mountInlineAgentContainer(
  message: Element,
  container: HTMLElement,
): void {
  // React 流式/续轮会高频改动 message 子树：
  // 1) 用 rAF 把一帧内的多个 mutation 合并成一次执行，避免每个增量都全量扫描；
  // 2) 只在容器脱离当前 host（被 React 重建/替换）时才重挂；
  // 3) 不再因"容器后面有兄弟节点"就把容器抢挪到末尾——那会打乱 React vDOM 记录的
  //    子节点顺序，下一帧 reconcile 时 removeChild 抛 NotFoundError，高频反复即渲染进程
  //    无响应崩溃（详见 doc/设计/流式崩溃根因v3-确证版-20261016.md）。
  let raf = 0;
  const placeContainer = () => {
    raf = 0;
    if (!container.isConnected) return;
    // adopt / autoCollapse 均自带幂等标记，rAF 合并后每帧最多执行一次，
    // 既保留"完成的 thinking 自动折叠"，又避免每个 mutation 都全树扫描。
    adoptMessageReasoningBlocks(message);
    const responseHost = getAssistantResponseHost(message);
    if (container.parentElement !== responseHost) {
      responseHost.appendChild(container);
    }
  };
  const schedulePlace = () => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(placeContainer);
  };

  placeContainer();

  inlineAgentContainerObserver?.disconnect();
  inlineAgentContainerObserver = new MutationObserver(schedulePlace);
  inlineAgentContainerObserver.observe(message, {
    childList: true,
    subtree: true,
  });
}

/**
 * Removes the old-style tool presentation (collapsible `.dpp-tool-block` +
 * detached `.dpp-artifact-results` cards) from a message's response host.
 * Called when an inline agent takes over the run record: the first native
 * turn's tools then render as the agent flow's first tool group, so the
 * record never shows both the legacy block and the new-style group for the
 * same executions.
 */
function removeToolBlockFromMessage(message: Element): void {
  const responseHost = getAssistantResponseHost(message);
  for (const node of Array.from(
    responseHost.querySelectorAll<HTMLElement>(
      ":scope > .dpp-tool-block, :scope > .dpp-artifact-results",
    ),
  )) {
    node.remove();
  }
}

function findInlineAgentLiveTarget(
  complete: ResponseCompletePayload,
  messages: Element[],
  anchorContent: string,
): Element | null {
  const messageId =
    complete.assistantMessageId == null
      ? null
      : String(complete.assistantMessageId);
  if (messageId) {
    const byId = messages.find((message) =>
      elementHasMessageId(message, messageId),
    );
    if (byId) return byId;
  }

  // A message already hosting an agent console belongs to an earlier run; a
  // fresh run never anchors into it (Issue #551 follow-up).
  const claimed = new Set(
    messages.filter((message) => message.querySelector(".dpp-agent-container")),
  );
  const byContent = findAssistantMessageByContentSnippet(
    messages,
    anchorContent,
    claimed,
  );
  if (byContent) return byContent;

  return messages[messages.length - 1] ?? null;
}

/**
 * True when an inline agent loop is mid-flight (an AbortController exists and
 * has not been aborted). Used by the concurrency guard in
 * {@link startInlineAgentIfNeeded} to skip launching a duplicate loop when the
 * user sends a follow-up message while a previous agent is still running
 * (issue #298).
 */
function isInlineAgentRunning(): boolean {
  const controller = activeAgentAbort;
  return controller !== null && !controller.signal.aborted;
}

/**
 * Synchronously detach the current agent panel and reset the module-level
 * bookkeeping. Does NOT abort the loop (the caller owns that) and does NOT
 * render a footer — used when a new loop supersedes an in-flight one so the
 * old panel disappears immediately instead of lingering until the aborted
 * stream settles (issue #298).
 */
function teardownInlineAgentPanel(): void {
  flushPendingInlineAgentStreamRender();
  stopAgentConsoleTimer();
  pendingAgentReasoningByStep.clear();
  if (inlineAgentContainer) {
    inlineAgentContainer.remove();
  }
  inlineAgentLoopId = null;
  inlineAgentContainer = null;
  inlineAgentCurrentStep = null;
  activeInlineAgentTrace = null;
  activeAgentModelBackend = null;
  inlineAgentContainerObserver?.disconnect();
  inlineAgentContainerObserver = null;
}

/* ------------------------------------------------------------------ */
/* 输入框常驻状态条：loop 运行时始终在用户视口内显示执行状态       */
/* ------------------------------------------------------------------ */

const AGENT_STATUS_BAR_STYLE_ID = "dpp-agent-status-bar-css";
const AGENT_STATUS_BAR_ID = "dpp-agent-status-bar";

function injectAgentStatusBarStyles(): void {
  if (document.getElementById(AGENT_STATUS_BAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = AGENT_STATUS_BAR_STYLE_ID;
  style.textContent = `
    #${AGENT_STATUS_BAR_ID} {
      position: sticky;
      bottom: 0;
      z-index: 9998;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      margin-bottom: 8px;
      border-radius: 10px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1a1a2e;
      background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
      border: 1px solid #c7d2fe;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15);
      animation: dpp-status-bar-in 0.25s ease-out;
    }
    #${AGENT_STATUS_BAR_ID}[data-phase="error"] {
      background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
      border-color: #fecaca;
    }
    #${AGENT_STATUS_BAR_ID}[data-phase="complete"] {
      background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
      border-color: #bbf7d0;
    }
    #${AGENT_STATUS_BAR_ID}[data-phase="stopped"] {
      background: linear-gradient(135deg, #fafafa 0%, #f4f4f5 100%);
      border-color: #e4e4e7;
      color: #71717a;
    }
    .dpp-status-bar-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6366f1;
      flex-shrink: 0;
    }
    #${AGENT_STATUS_BAR_ID}[data-phase="running"] .dpp-status-bar-dot,
    #${AGENT_STATUS_BAR_ID}[data-phase="starting"] .dpp-status-bar-dot {
      animation: dpp-status-pulse 1.2s ease-in-out infinite;
    }
    #${AGENT_STATUS_BAR_ID}[data-phase="error"] .dpp-status-bar-dot { background: #ef4444; }
    #${AGENT_STATUS_BAR_ID}[data-phase="complete"] .dpp-status-bar-dot { background: #22c55e; }
    #${AGENT_STATUS_BAR_ID}[data-phase="stopped"] .dpp-status-bar-dot { background: #a1a1aa; }
    .dpp-status-bar-text {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dpp-status-bar-text strong {
      font-weight: 600;
    }
    .dpp-status-bar-tool {
      color: #6366f1;
      font-family: "SF Mono", Consolas, monospace;
      font-size: 12px;
      background: rgba(99, 102, 241, 0.1);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .dpp-status-bar-btn {
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid #c7d2fe;
      background: #fff;
      color: #4f46e5;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .dpp-status-bar-btn:hover {
      background: #eef2ff;
      border-color: #a5b4fc;
    }
    .dpp-status-bar-btn[aria-disabled="true"] {
      opacity: 0.45;
      cursor: pointer;
      background: #fff;
      border-color: #e2e8f0;
      color: #94a3b8;
    }
    .dpp-status-bar-btn[aria-disabled="true"]:hover {
      background: #fff;
      border-color: #e2e8f0;
    }
    .dpp-status-bar-btn.stop {      color: #dc2626;
      border-color: #fecaca;
    }
    .dpp-status-bar-btn.stop:hover {
      background: #fef2f2;
      border-color: #fca5a5;
    }
    @keyframes dpp-status-bar-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes dpp-status-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
  `;
  document.head.appendChild(style);
}

function findAgentStatusBarAnchor(): HTMLElement | null {
  const textarea = getPromptTextarea();
  if (!textarea) return null;
  // 向上找到输入框的容器（通常是 textarea 的父级或祖父级）
  let el: Element | null = textarea.parentElement;
  const root = document.getElementById("root") ?? document.body;
  while (el && el !== root) {
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      // 输入框容器通常有明确的 padding/border，且宽度接近 textarea
      if (rect.width >= textarea.getBoundingClientRect().width * 0.9 &&
          rect.height >= textarea.getBoundingClientRect().height) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return textarea.parentElement;
}

/**
 * 「详情」按钮：定位并展开本轮真实工具卡片（实现见 core/inline-agent/tool-details-reveal）。
 *
 * 修复（2026-10-26 用户报告）：原来只 scrollIntoView(inlineAgentContainer)，不展开任何东西，
 * 且在容器为 null 时点了完全没反应。现委托给可单测的 core 实现，两种卡片按各自契约展开。
 */
function revealToolDetails(): boolean {
  return revealToolDetailsCore(document);
}

/**
 * 同步「详情」按钮的可用外观。
 *
 * 用 `aria-disabled` 而**不是** `.disabled`：真正的 disabled 会吞掉点击事件，
 * 而工具卡片是异步出现的（agent 跑完第一个工具才有）。若卡片恰好在下一次状态条
 * 刷新之前出现，真 disabled 的按钮就又变成「点了没反应」——正是本次要修的毛病。
 * 用 aria-disabled 时点击仍会进 handler，由 handler 重新判定并在可用时展开；
 * 视觉上仍是灰态（CSS 见 [aria-disabled="true"]），可访问性语义也保留。
 */
function syncDetailButtonAvailability(): void {
  const btn = agentStatusBarEl?.querySelector<HTMLButtonElement>(
    ".dpp-status-bar-btn:not(.stop)",
  );
  if (!btn) return;
  const available = hasVisibleToolCards(document);
  btn.setAttribute("aria-disabled", available ? "false" : "true");
  btn.title = available
    ? contentT("content.agent.statusBarDetailHint")
    : contentT("content.agent.statusBarDetailUnavailable");
}

function ensureAgentStatusBar(): HTMLElement | null {
  injectAgentStatusBarStyles();
  if (agentStatusBarEl && agentStatusBarEl.isConnected) return agentStatusBarEl;

  const anchor = findAgentStatusBarAnchor();
  if (!anchor) return null;

  // 如果已有旧的状态条但不在 DOM 中，重建
  agentStatusBarEl?.remove();

  const bar = document.createElement("div");
  bar.id = AGENT_STATUS_BAR_ID;
  bar.setAttribute("data-phase", "starting");

  const dot = document.createElement("span");
  dot.className = "dpp-status-bar-dot";

  const text = document.createElement("span");
  text.className = "dpp-status-bar-text";

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "dpp-status-bar-btn";
  detailBtn.textContent = contentT("content.agent.statusBarDetail");
  detailBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // 修复：定位并**展开**真实工具卡片，而不是只滚动 agent 容器。
    // 每次点击都重新判定可用态：卡片可能在两次状态条刷新之间才出现，
    // 此时点一下就恢复，而不是留下一个吞点击的死按钮。
    revealToolDetails();
    syncDetailButtonAvailability();
  });

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "dpp-status-bar-btn stop";
  stopBtn.textContent = contentT("content.agent.stop");
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopInlineAgent();
  });

  bar.appendChild(dot);
  bar.appendChild(text);
  bar.appendChild(detailBtn);
  bar.appendChild(stopBtn);

  // 插入到输入框容器的最前面（输入框上方）
  anchor.insertBefore(bar, anchor.firstChild);
  agentStatusBarEl = bar;
  return bar;
}

function updateAgentStatusBar(
  phase: "starting" | "running" | "complete" | "error" | "stopped",
  options?: { step?: number; tool?: string; elapsedSeconds?: number; message?: string },
): void {
  const bar = ensureAgentStatusBar();
  if (!bar) return;

  bar.setAttribute("data-phase", phase);
  const textEl = bar.querySelector<HTMLElement>(".dpp-status-bar-text");
  if (!textEl) return;

  const step = options?.step ?? agentStatusBarCurrentStep;
  const tool = options?.tool ?? agentStatusBarCurrentTool;
  const elapsed = options?.elapsedSeconds ?? agentConsoleElapsedSeconds;

  let html = "";
  switch (phase) {
    case "starting":
      // Step 3：延长窗等待时 message 携带「页面仍在渲染（已等 N 秒）」
      // （第十一批；escapeHtml 防 i18n 参数注入——虽然当前参数是数字）。
      html = options?.message
        ? `<strong>deepseek++</strong> ${escapeHtml(options.message)}`
        : `<strong>deepseek++</strong> ${contentT("content.agent.statusBarStarting")}`;
      break;
    case "running": {
      const parts = [`<strong>deepseek++</strong> ${contentT("content.agent.statusBarRunning")}`, contentT("content.agent.statusBarStep", { step: step + 1 })];
      // 审计 #30（2026-10-24 报告 P1）：tool 名来自 msg.call.name，MCP 工具名由
      // **外部服务器**提供，属不可信数据；直接拼 innerHTML 即注入口。
      // 同函数的 complete/error 分支此前已补 escapeHtml，此处是漏掉的一处。
      if (tool) parts.push(`<span class="dpp-status-bar-tool">${escapeHtml(tool)}</span>`);
      if (elapsed > 0) parts.push(`${formatElapsedSeconds(elapsed)}`);
      html = parts.join(" · ");
      break;
    }
    case "complete":
      // 审计 P1-56：message 可能含错误链路/LLM 输出片段，必须转义再拼 innerHTML
      html = `<strong>deepseek++</strong> ${contentT("content.agent.statusBarComplete", { message: escapeHtml(String(options?.message ?? "")) })}`;
      break;
    case "error":
      html = `<strong>deepseek++</strong> ${contentT("content.agent.statusBarError", { message: escapeHtml(String(options?.message ?? "")) })}`;
      break;
    case "stopped":
      html = `<strong>deepseek++</strong> ${contentT("content.agent.statusBarStopped")}`;
      break;
  }
  textEl.innerHTML = html;

  // 停止按钮只在 running/starting 时显示
  const stopBtn = bar.querySelector<HTMLButtonElement>(".dpp-status-bar-btn.stop");
  if (stopBtn) stopBtn.style.display = (phase === "running" || phase === "starting") ? "" : "none";
  // 状态条跨 step 复用，所以每次更新都同步一次「详情」按钮可用态：
  // 卡片还没出现时禁用并给 title 说明，出现后自动恢复可点。
  syncDetailButtonAvailability();
}

function scheduleRemoveAgentStatusBar(delayMs = 3000): void {
  if (agentStatusBarRemoveTimer) clearTimeout(agentStatusBarRemoveTimer);
  agentStatusBarRemoveTimer = setTimeout(() => {
    agentStatusBarEl?.remove();
    agentStatusBarEl = null;
    agentStatusBarRemoveTimer = null;
  }, delayMs);
}

function formatElapsedSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
}

/* ------------------------------------------------------------------ */
/* 并发保护确认对话框：loop 运行时用户发新消息，询问是否中断       */
/* ------------------------------------------------------------------ */

const AGENT_CONCURRENCY_DIALOG_ID = "dpp-agent-concurrency-dialog";
const AGENT_CONCURRENCY_STYLE_ID = "dpp-agent-concurrency-css";

function injectAgentConcurrencyStyles(): void {
  if (document.getElementById(AGENT_CONCURRENCY_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = AGENT_CONCURRENCY_STYLE_ID;
  style.textContent = `
    #${AGENT_CONCURRENCY_DIALOG_ID}-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      animation: dpp-concurrency-fade-in 0.15s ease-out;
    }
    #${AGENT_CONCURRENCY_DIALOG_ID} {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
      overflow: hidden;
      animation: dpp-concurrency-scale-in 0.2s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .dpp-concurrency-header {
      padding: 20px 24px 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .dpp-concurrency-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #fef3c7, #fde68a);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    .dpp-concurrency-title {
      font-size: 16px;
      font-weight: 600;
      color: #1a1a2e;
      margin: 0;
    }
    .dpp-concurrency-body {
      padding: 12px 24px 20px;
      font-size: 14px;
      line-height: 1.6;
      color: #4b5563;
    }
    .dpp-concurrency-body strong {
      color: #6366f1;
    }
    .dpp-concurrency-footer {
      padding: 0 24px 20px;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .dpp-concurrency-btn {
      padding: 8px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      border: 1px solid transparent;
    }
    .dpp-concurrency-btn.cancel {
      background: #f3f4f6;
      color: #4b5563;
      border-color: #e5e7eb;
    }
    .dpp-concurrency-btn.cancel:hover {
      background: #e5e7eb;
    }
    .dpp-concurrency-btn.confirm {
      background: #dc2626;
      color: #fff;
    }
    .dpp-concurrency-btn.confirm:hover {
      background: #b91c1c;
    }
    @keyframes dpp-concurrency-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes dpp-concurrency-scale-in {
      from { opacity: 0; transform: scale(0.95) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

function showAgentConcurrencyConfirm(): Promise<boolean> {
  return new Promise((resolve) => {
    injectAgentConcurrencyStyles();

    // 移除已存在的对话框
    document.getElementById(`${AGENT_CONCURRENCY_DIALOG_ID}-overlay`)?.remove();

    const overlay = document.createElement("div");
    overlay.id = `${AGENT_CONCURRENCY_DIALOG_ID}-overlay`;

    const dialog = document.createElement("div");
    dialog.id = AGENT_CONCURRENCY_DIALOG_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "dpp-concurrency-header";
    const icon = document.createElement("div");
    icon.className = "dpp-concurrency-icon";
    icon.textContent = "⚠️";
    const title = document.createElement("h3");
    title.className = "dpp-concurrency-title";
    title.textContent = contentT("content.agent.concurrencyTitle");
    header.appendChild(icon);
    header.appendChild(title);

    const body = document.createElement("div");
    body.className = "dpp-concurrency-body";
    body.innerHTML = contentT("content.agent.concurrencyBody");

    const footer = document.createElement("div");
    footer.className = "dpp-concurrency-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "dpp-concurrency-btn cancel";
    cancelBtn.textContent = contentT("content.agent.concurrencyCancel");

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "dpp-concurrency-btn confirm";
    confirmBtn.textContent = contentT("content.agent.concurrencyConfirm");

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 自动聚焦确认按钮
    setTimeout(() => confirmBtn.focus(), 50);
  });
}

function stopInlineAgent(): void {
  stopAgentConsoleTimer();
  removeAgentStartingElement();
  updateAgentStatusBar("stopped");
  scheduleRemoveAgentStatusBar(2000);
  const container = inlineAgentContainer;
  updateActiveInlineAgentTrace(
    (trace) => ({
      ...trace,
      status: "stopping",
      error: contentT("content.agent.stopped"),
    }),
    { immediate: true },
  );
  // Reset module state (DOM bookkeeping + observers). The container itself is
  // retained momentarily so its header can switch to the neutral paused state,
  // then detached once the aborted loop settles.
  flushPendingInlineAgentStreamRender();
  pendingAgentReasoningByStep.clear();
  inlineAgentLoopId = null;
  inlineAgentContainer = null;
  inlineAgentCurrentStep = null;
  activeInlineAgentTrace = null;
  activeAgentModelBackend = null;
  inlineAgentContainerObserver?.disconnect();
  inlineAgentContainerObserver = null;
  activeAgentAbort?.abort(AGENT_USER_ABORT_REASON);
  activeAgentAbort = null;
  if (container) {
    // Stop is a neutral pause, never a fake completion: the status line keeps
    // the interrupted step visible and pending tool entries stop pulsing.
    const stream = getAgentConsoleBody(container);
    if (stream) finalizePendingAgentToolEntries(stream);
    renderTerminalAgentConsoleHeader(
      container,
      "paused",
      0,
      0,
      contentT("content.agent.stopped"),
    );
  }
}

async function startInlineAgentLoop(
  payload: InlineAgentStartPayload,
): Promise<void> {
  // B2: the caller may pre-select a model backend; otherwise auto-select the
  // official API when an official API key is configured (same semantics as
  // the sidepanel chat). No key → the released web backend.
  if (!payload.modelBackend) {
    payload.modelBackend = (await getDeepSeekApiKey()) ? "official-api" : "web";
  }
  // Abort any previously running loop AND tear down its panel synchronously
  // before mounting the new one. Previously the old panel stayed in the DOM
  // until the aborted stream settled, so two agent panels briefly raced
  // (issue #298).
  if (activeAgentAbort) {
    activeAgentAbort.abort(AGENT_USER_ABORT_REASON);
    teardownInlineAgentPanel();
  }
  const modelBackend = payload.modelBackend;
  const abort = new AbortController();
  // Arm the concurrency guard only after every synchronous statement that can
  // throw. If a throw landed between arming activeAgentAbort and entering the
  // try below, no clear path would run and the guard would stay latched until a
  // page reload, making every later turn hit "inline agent already running".
  agentRunningToolCount = payload.toolExecutions.length;
  activeAgentModelBackend = modelBackend;
  activeAgentAbort = abort;

  // 输入框常驻状态条 + 宠物立即 working（不等 AGENT_STEP_STARTED）
  agentStatusBarCurrentStep = 0;
  agentStatusBarCurrentTool = null;
  updateAgentStatusBar("starting");
  setPetState("working");

  const authorizationRequestKey = `agent:${payload.loopId}`;
  const capabilityScopeRequestId =
    payload.capabilityScopeRequestId ?? authorizationRequestKey;
  let authorization: ToolAuthorizationGrantSummary;
  try {
    authorization = await createContentToolAuthorization({
      requestId: capabilityScopeRequestId,
      trigger: "agent_run",
      chatSessionId: payload.chatSessionId,
      runId: payload.loopId,
      descriptorIds: payload.toolDescriptors.map((descriptor) => descriptor.id),
    });
    activeToolAuthorizations.set(authorizationRequestKey, authorization);
    inlineAgentAuthorizationRequestKeys.set(
      payload.loopId,
      authorizationRequestKey,
    );
  } catch (error) {
    handleAgentLoopError({
      loopId: payload.loopId,
      stepIndex: 0,
      totalTools: payload.toolExecutions.length,
      error: error instanceof Error ? error.message : String(error),
    });
    if (activeAgentAbort === abort) {
      activeAgentAbort = null;
      activeAgentModelBackend = null;
    }
    return;
  }

  const terminalTasks: Promise<boolean>[] = [];
  const post = (type: string, data: unknown) => {
    const terminalTask = handleInlineAgentLoopEvent(
      type,
      data,
      activeAgentModelBackend ?? modelBackend,
    );
    if (terminalTask) terminalTasks.push(terminalTask);
  };

  const executeTool = async (call: ToolCall, signal?: AbortSignal): Promise<ToolExecutionRecord> => {
    if (signal?.aborted) {
      return {
        name: call.name,
        result: {
          ok: false,
          summary: 'tool aborted before execution',
          error: { code: 'tool_aborted', message: 'Aborted by user', retryable: false },
        },
      };
    }
    // P0-2 第 2.3 项：工具往返计时。此前 tool.exec.durationMs 恒 undefined
    // （工具结果不携带耗时），报告里永远看不到 shell_exec 真实毫秒数。
    const execStartedAt = performance.now();
    const enrichedCall: ToolCall = ensureToolCallId({
      ...call,
      source: {
        trigger: "agent_run",
        requestId: capabilityScopeRequestId,
        chatSessionId: payload.chatSessionId,
        runId: payload.loopId,
      },
    });
    let result = await executeToolCall(enrichedCall, authorization.id);

    // 授权丢失自动重试：background state 可能因扩展重载/页面刷新而清空，
    // 此时自动重新创建 grant 并重试一次，不让 loop 直接失败。
    const authErrorCode = result.error?.code;
    if (
      !result.ok &&
      (authErrorCode === "tool_authorization_missing" ||
        authErrorCode === "tool_authorization_stale")
    ) {
      console.warn("[DPP-AUTO] 授权丢失，自动重新授权并重试", authErrorCode);
      try {
        // 关闭旧授权（如果还在）
        await closeContentToolAuthorization(authorizationRequestKey);
        // 用相同参数创建新授权
        const newAuth = await createContentToolAuthorization({
          requestId: capabilityScopeRequestId,
          trigger: "agent_run",
          chatSessionId: payload.chatSessionId,
          runId: payload.loopId,
          descriptorIds: authorization.descriptors.map((d) => d.id),
        });
        activeToolAuthorizations.set(authorizationRequestKey, newAuth);
        // 更新外层 authorization 引用，供后续工具调用使用
        authorization = newAuth;
        // 重试
        result = await executeToolCall(enrichedCall, newAuth.id);
      } catch (reauthError) {
        console.error("[DPP-AUTO] 自动重新授权失败", reauthError);
      }
    }

    const durationMs = Math.round(performance.now() - execStartedAt);
    // 直接带耗时入库；flushTraceStep 不再重复 emit tool.exec。
    activeTraceTracker?.toolExec(result.name ?? call.name, durationMs, Boolean(result.ok));

    return {
      name: result.name ?? call.name,
      result: {
        ok: result.ok,
        name: result.name,
        provider: result.provider,
        descriptorId: result.descriptorId,
        summary: result.summary,
        detail: result.detail,
        output: result.output,
        error: result.error,
        truncated: result.truncated,
      },
      provider: result.provider ?? call.provider,
      descriptorId: result.descriptorId ?? call.descriptorId,
    };
  };

  let shouldReloadNativeHistory = false;
  try {
    // M-URL 修复：上传图片到 DeepSeek 服务器，返回 file_id
    // 注意：传入 URL，由 background SW 下载（避免 content script 的 Mixed Content 限制）
    const uploadImage: NonNullable<import('../core/inline-agent/loop').InlineAgentLoopDeps['uploadImage']> = async (input) => {
      try {
        const response = await sendRuntimeMessageStrict<{ ok: boolean; file?: { id: string }; error?: string }>({
          type: "UPLOAD_DEEPSEEK_IMAGE",
          payload: {
            url: input.url,
            name: input.name,
          },
        });
        if (response.ok && response.file?.id) {
          return response.file.id;
        }
        console.warn('[M-URL] 上传失败:', response.error || 'unknown error');
        return null;
      } catch (error) {
        console.warn('[M-URL] 上传异常:', error instanceof Error ? error.message : String(error));
        return null;
      }
    };

    await runInlineAgentLoop(
      {
        ...payload,
        toolDescriptors: [
          ...projectToolDescriptorsForNativeSearch(
            authorization.descriptors,
            payload.promptOptions.searchEnabled,
          ),
        ],
      },
      { post, executeTool, signal: abort.signal, uploadImage },
    );
    if (terminalTasks.length > 0) {
      const terminalResults = await Promise.all(terminalTasks);
      shouldReloadNativeHistory = terminalResults.some(Boolean);
    }
  } finally {
    await closeContentToolAuthorization(authorizationRequestKey);
    if (activeAgentAbort === abort) {
      activeAgentAbort = null;
      activeAgentModelBackend = null;
    }
  }

  // Reload only after the terminal trace write and authorization teardown have
  // both settled. The new document then reads the real DeepSeek history; no
  // synthetic request, XHR lifecycle, or local response graph is involved.
  if (shouldReloadNativeHistory) reloadInlineAgentNativeHistory();
}

function handleInlineAgentLoopEvent(
  type: string,
  data: unknown,
  modelBackend: InlineAgentModelBackend,
): Promise<boolean> | null {
  switch (type) {
    case "AGENT_STEP_STARTED": {
      const msg = data as { loopId: string; stepIndex: number };
      setPetState("working");
      agentStatusBarCurrentStep = msg.stepIndex;
      agentStatusBarCurrentTool = null;
      updateAgentStatusBar("running", { step: msg.stepIndex });
      handleAgentStepStarted(msg);
      advanceTraceTurn(msg.loopId, msg.stepIndex);
      break;
    }
    case "AGENT_STREAM_CHUNK":
      setPetState("speaking");
      activeTraceTracker?.sseFrame("text");
      handleAgentStreamChunk(data as InlineAgentStreamChunkMsg);
      break;
    case "AGENT_REASONING_CHUNK":
      activeTraceTracker?.sseFrame("think");
      handleAgentReasoningChunk(data as InlineAgentReasoningChunkMsg);
      break;
    case "AGENT_TOKEN_SPEED": {
      const progress = normalizeResponseTokenSpeedPayload(data);
      if (progress) {
        updateTokenSpeedIndicator(progress);
        updatePetFromTokenSpeed(progress);
      }
      break;
    }
    case "AGENT_TOOL_DETECTED": {
      const msg = data as InlineAgentToolDetectedMsg;
      agentStatusBarCurrentTool = msg.call.name;
      updateAgentStatusBar("running", { step: msg.stepIndex, tool: msg.call.name });
      handleAgentToolDetected(msg);
      activeTraceTracker?.toolParsed(msg.call.name, "OK");
      break;
    }
    case "AGENT_STEP_COMPLETE": {
      // 不再 schedulePetIdle：loop 可能还在跑下一轮，宠物保持 working
      const msg = data as InlineAgentStepCompleteMsg;
      handleAgentStepComplete(msg);
      flushTraceStep(msg.toolExecutions);
      break;
    }
    case "AGENT_LOOP_COMPLETE": {
      const msg = data as InlineAgentLoopCompleteMsg;
      // W29：先收尾轨迹（含 stopReason），再走原有的完成处理。
      finishTraceRun(msg.stopReason ?? "finalized", msg.finalText.trim().length > 0);
      const terminalTask = handleAgentLoopComplete(msg, modelBackend);
      setPetState("success");
      schedulePetIdle(PET_FEEDBACK_DELAY_MS);
      updateAgentStatusBar("complete", {
        step: msg.totalSteps - 1,
        message: contentT("content.agent.stepsTools", { steps: msg.totalSteps, tools: msg.totalTools }),
      });
      scheduleRemoveAgentStatusBar(4000);
      return terminalTask;
    }
    case "AGENT_LOOP_ERROR": {
      const msg = data as InlineAgentLoopErrorMsg;
      finishTraceRun(msg.stopReason ?? "turn_error", false);
      setPetState("error");
      handleAgentLoopError(msg);
      schedulePetIdle(PET_FEEDBACK_DELAY_MS);
      updateAgentStatusBar("error", { message: msg.error ? `：${msg.error}` : "" });
      scheduleRemoveAgentStatusBar(5000);
      break;
    }
  }
  return null;
}

function removeAgentStartingElement(): void {
  inlineAgentContainer?.querySelector(".dpp-agent-starting")?.remove();
  inlineAgentContainer?.removeAttribute("data-agent-starting");
}

function handleAgentStepStarted(data: {
  loopId: string;
  stepIndex: number;
}): void {
  if (data.loopId !== inlineAgentLoopId || !inlineAgentContainer) return;
  removeAgentStartingElement();
  pendingAgentReasoningByStep.delete(data.stepIndex);

  // The narration segment mounts into the stream on its first non-empty text
  // (textless tool-only steps leave no empty paragraph in the flow).
  const stepEl = createAgentStepElement(data.stepIndex);
  inlineAgentCurrentStep = stepEl;
  updateAgentConsoleHeader(
    inlineAgentContainer,
    {
      phase: "running",
      stepNumber: data.stepIndex,
      toolCount: agentRunningToolCount,
      totalSteps: 0,
      totalTools: 0,
      elapsedSeconds: getAgentConsoleElapsedSeconds(),
    },
    getAgentRendererLabels(),
  );
  updateActiveInlineAgentTrace((trace) =>
    upsertInlineAgentTraceStep(trace, {
      index: data.stepIndex,
      status: "streaming",
      text: "",
      toolExecutions: [],
      responseMessageId: null,
      collapsed: false,
    }),
  );
}

/**
 * Tool calls were detected in the model turn: surface each call as a pending
 * single-line work-log entry (icon + name + parameter summary) in the current
 * tool group; the entries are completed by the step's execution records
 * (Issue #551 redesign).
 */
function handleAgentToolDetected(msg: InlineAgentToolDetectedMsg): void {
  if (msg.loopId !== inlineAgentLoopId || !inlineAgentContainer) return;
  const stream = getAgentConsoleBody(inlineAgentContainer);
  if (stream && inlineAgentCurrentStep) {
    addAgentToolEntry(
      stream,
      msg.stepIndex,
      msg.call,
      getAgentRendererLabels(),
    );
  }
  agentRunningToolCount += 1;
  updateActiveInlineAgentTrace((trace) =>
    updateInlineAgentTraceStep(trace, msg.stepIndex, {
      status: "executing_tools",
    }),
  );
}

function handleAgentStreamChunk(msg: InlineAgentStreamChunkMsg): void {
  if (msg.loopId !== inlineAgentLoopId || !inlineAgentCurrentStep) return;
  pendingInlineAgentStreamChunk = msg;
  if (inlineAgentStreamRenderFrame !== null) return;

  inlineAgentStreamRenderFrame = requestAnimationFrame(() => {
    inlineAgentStreamRenderFrame = null;
    const next = pendingInlineAgentStreamChunk;
    pendingInlineAgentStreamChunk = null;
    if (next) renderInlineAgentStreamChunk(next);
  });
}

/**
 * Live reasoning deltas of the current step (AGENT_REASONING_CHUNK). The text
 * is accumulated into the step's reasoning note — created when the narration
 * mounts, or mounted on demand here — and persisted into the trace so a page
 * refresh restores the same content (Issue: reasoning-not-persisted).
 */
function handleAgentReasoningChunk(msg: InlineAgentReasoningChunkMsg): void {
  if (msg.loopId !== inlineAgentLoopId || !inlineAgentContainer) return;
  if (!msg.fullText) return;

  const stream = getAgentConsoleBody(inlineAgentContainer);
  const step = inlineAgentCurrentStep;
  const reasoningText = msg.fullText;

  if (step && step.parentElement === stream) {
    const note = getAgentReasoningNote(step);
    if (note) updateAgentReasoningNoteElement(note, reasoningText);
  } else {
    pendingAgentReasoningByStep.set(msg.stepIndex, reasoningText);
    // Reasoning without any narration text: mount the (textless) step so the
    // note has a home in the stream instead of being silently dropped.
    if (step && stream && step.parentElement !== stream) {
      mountAgentNarration(
        step,
        stream,
        getAgentRendererLabels(),
        reasoningText,
      );
    }
  }

  updateActiveInlineAgentTrace((trace) =>
    updateInlineAgentTraceStep(trace, msg.stepIndex, {
      reasoning: reasoningText,
    }),
  );
}

function renderInlineAgentStreamChunk(msg: InlineAgentStreamChunkMsg): void {
  if (
    msg.loopId !== inlineAgentLoopId ||
    !inlineAgentCurrentStep ||
    !inlineAgentContainer
  )
    return;
  const step = inlineAgentCurrentStep;
  const previousText = getInlineAgentStepText(step);
  const nextText =
    clampText(
      getInlineAgentDisplayStepText(msg.fullText, currentToolDescriptors) ||
        previousText,
      INLINE_AGENT_STEP_RENDER_MAX_CHARS,
    ) ?? "";
  if (nextText) {
    const stream = getAgentConsoleBody(inlineAgentContainer);
    if (stream) mountAgentNarration(step, stream, getAgentRendererLabels());
  }
  // Reasoning that streamed in before the narration mounted belongs to this
  // step's note; fill it now that the note exists.
  const pendingReasoning = pendingAgentReasoningByStep.get(msg.stepIndex);
  if (pendingReasoning) {
    const note = getAgentReasoningNote(step);
    if (note) updateAgentReasoningNoteElement(note, pendingReasoning);
  }
  updateStepStreamText(step, nextText);
  refreshAgentStepCodeRunners(step);
  updateActiveInlineAgentTrace((trace) =>
    updateInlineAgentTraceStep(trace, msg.stepIndex, {
      text: nextText,
      ...(nextText ? { status: "streaming" as const } : {}),
    }),
  );
}

/**
 * Incremental code-run support on the agent console (native renderer does
 * not run these languages): hydrates the run action onto code blocks whose
 * language is javascript/typescript/python, executing through the background
 * sandbox runner. Languages the DeepSeek native renderer presents itself
 * (html/svg/xml/mermaid plus xychart shorthand normalized in stored history)
 * are never touched; after the web run commits, the new document renders those
 * blocks from the real DeepSeek response.
 */
function refreshAgentStepCodeRunners(step: HTMLElement): void {
  hydrateAgentStepCodeRunners(
    step,
    async (code, language) => {
      try {
        const result = await sendRuntimeMessage<ToolCardResult>({
          type: "RUN_ARTIFACT_CODE",
          payload: {
            language,
            code,
            timeoutMs: language === "python" ? 15_000 : 5_000,
          },
        });
        if (!result) {
          const unavailable = contentT("content.agent.codeRunnerUnavailable");
          return { ok: false, error: { message: unavailable } };
        }
        return {
          ok: result.ok,
          output: result.output,
          detail: result.detail,
          error: result.error ? { message: result.error.message } : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    getAgentRendererLabels(),
  );
}

function flushPendingInlineAgentStreamRender(): void {
  if (inlineAgentStreamRenderFrame !== null) {
    cancelAnimationFrame(inlineAgentStreamRenderFrame);
    inlineAgentStreamRenderFrame = null;
  }

  const next = pendingInlineAgentStreamChunk;
  pendingInlineAgentStreamChunk = null;
  if (next) renderInlineAgentStreamChunk(next);
}

function cancelPendingInlineAgentStreamRender(): void {
  if (inlineAgentStreamRenderFrame !== null) {
    cancelAnimationFrame(inlineAgentStreamRenderFrame);
    inlineAgentStreamRenderFrame = null;
  }
  pendingInlineAgentStreamChunk = null;
}

function handleAgentStepComplete(msg: InlineAgentStepCompleteMsg): void {
  if (
    msg.loopId !== inlineAgentLoopId ||
    !inlineAgentCurrentStep ||
    !inlineAgentContainer
  )
    return;
  flushPendingInlineAgentStreamRender();

  const stream = getAgentConsoleBody(inlineAgentContainer);
  for (const exec of msg.toolExecutions) {
    if (stream) {
      resolveAgentToolEntry(
        stream,
        msg.stepIndex,
        exec,
        getAgentRendererLabels(),
      );
    }
  }
  updateAgentConsoleHeader(
    inlineAgentContainer,
    {
      phase: "running",
      stepNumber: msg.stepIndex,
      toolCount: agentRunningToolCount,
      totalSteps: 0,
      totalTools: 0,
      elapsedSeconds: getAgentConsoleElapsedSeconds(),
    },
    getAgentRendererLabels(),
  );

  updateStepStatus(inlineAgentCurrentStep, "complete");
  const fullText = getInlineAgentStepText(inlineAgentCurrentStep);
  updateActiveInlineAgentTrace(
    (trace) =>
      updateInlineAgentTraceStep(trace, msg.stepIndex, {
        status: "complete",
        text: fullText,
        toolExecutions: msg.toolExecutions,
        responseMessageId: msg.responseMessageId,
        collapsed: true,
      }),
    { immediate: true },
  );

  inlineAgentCurrentStep = null;
}

async function handleAgentLoopComplete(
  msg: InlineAgentLoopCompleteMsg,
  modelBackend: InlineAgentModelBackend,
): Promise<boolean> {
  if (msg.loopId !== inlineAgentLoopId || !inlineAgentContainer) return false;
  stopAgentConsoleTimer();
  removeAgentStartingElement();
  flushPendingInlineAgentStreamRender();

  let completedTrace: InlineAgentTraceRecord | null = null;
  let shouldReloadNativeHistory = false;
  try {
    inlineAgentContainerObserver?.disconnect();
    inlineAgentContainerObserver = null;

    // The stream redesign (Issue #551): the final turn is the LAST narration
    // segment of the body stream — there is no separate answer area. The
    // extension keeps this visible until the persisted web trace is committed;
    // the subsequent new document delegates the same response to DeepSeek's
    // real history renderer.
    const displayFinalText = getInlineAgentDisplayFinalText(
      msg.finalText,
      currentToolDescriptors,
    );

    // Budget-exhausted loops end with the budget notice as their final text;
    // they are paused, not complete, and must never trigger a history reload.
    const budgetPaused = isInlineAgentBudgetFinalText(msg.finalText, (count) =>
      contentT("content.agent.budgetReached", { count }),
    );
    const completedSteps =
      inlineAgentContainer.querySelectorAll(".dpp-agent-step");
    const lastCompletedStep = completedSteps[completedSteps.length - 1] as
      HTMLElement | undefined;
    const lastCompletedStepText = lastCompletedStep
      ? getInlineAgentStepText(lastCompletedStep)
      : "";
    const resolvedAnswer = budgetPaused
      ? { answer: displayFinalText, fromStep: false }
      : resolveInlineAgentAnswerText(displayFinalText, lastCompletedStepText);
    const finalText = resolvedAnswer.answer;

    // 1) 先把 trace 落为 complete（修复：守卫之前先置 complete，否则守卫读 running 状态恒假）
    completedTrace = updateActiveInlineAgentTrace(
      (trace) => ({
        ...trace,
        status: "complete",
        totalSteps: msg.totalSteps,
        totalTools: msg.totalTools,
        finalText:
          clampText(finalText, INLINE_AGENT_FINAL_RENDER_MAX_CHARS) ?? "",
      }),
      { persist: false },
    );

    // M0 G2/深度：一次 inline agent run 收尾，记录最终深度与工具数（finalDepth=总步数）。
    refactorTelemetry.recordHarnessEvent({
      type: "turn_finished",
      turnId: msg.loopId,
      finalDepth: Math.max(0, Number(msg.totalSteps) || 0),
      toolCallCount: Math.max(0, Number(msg.totalTools) || 0),
      timestamp: Date.now(),
    });

    // 2) 用「已 complete」的 completedTrace 做去重判断
    // 该轮是否由原生消息拥有最终答案 —— 判定**只在** traceOwnsFinalTurn 一处：
    // live 与 refresh-restore 共用，禁止再传额外条件（否则跨刷新归属不一致）。
    const ownsFinalTurn = traceOwnsFinalTurn(completedTrace ?? null, { budgetPaused });

    // 3) 路由：原生拥有 ⇒ **清空**扩展已流式画在屏上的那份（不是"跳过再画"）。
    //    原实现只做 skip，屏上那份永远留着 ⇒ 原生一份 + 扩展一份。
    const finalAnswerAction = routeFinalAnswer({
      ownsFinalTurn,
      isNudgeTurn: msg.isNudge === true,
      finalText,
      resolvedAnswer,
      lastStepText: lastCompletedStepText,
      // 工具记录决定"能不能整块删"：有记录时只清正文，否则会连工具历史一起丢。
      lastStepHasToolEntries: Boolean(
        lastCompletedStep?.querySelector(".dpp-agent-tool-group"),
      ),
      isFinalStepText: isInlineAgentStepTextTheFinalAnswer,
    });
    // 审计 P3-12：五种 action → 五种 DOM 操作收敛到 applyFinalAnswerAction，
    // 该调度有独立用例（含"clear-text 不得整步清空"），堵住 live 接线无人区。
    applyFinalAnswerAction(finalAnswerAction, {
      step: lastCompletedStep ?? null,
      container: inlineAgentContainer,
      loopId: msg.loopId,
      clearStep: (step) => updateStepStreamText(step, ""),
      clearText: (step) => clearStepBodyText(step),
      replaceText: (step, text) => updateStepStreamText(step, text),
      appendText: (container, text, loopId) => appendInlineAgentNarration(container, text, loopId),
      refreshCodeRunners: (step) => refreshAgentStepCodeRunners(step),
    });
    // F2（独立评审 §6）：截断轮不得显示「已完成」—— 统一由 resolveTerminalHeader 决策。
    const terminalHeader = resolveTerminalHeader({
      interrupted: msg.interrupted === true,
      budgetPaused,
    });
    renderTerminalAgentConsoleHeader(
      inlineAgentContainer,
      terminalHeader.phase,
      msg.totalSteps,
      msg.totalTools,
      terminalHeader.labelKey ? contentT(terminalHeader.labelKey) : undefined,
    );
    const stream = getAgentConsoleBody(inlineAgentContainer);
    if (stream) {
      collapseAllAgentToolGroups(stream);
      finalizePendingAgentToolEntries(stream);
    }

    // 4) 刷新判定保持用 completedTrace（本就是对的）
    if (completedTrace) {
      shouldReloadNativeHistory = shouldReloadInlineAgentNativeHistory({
        modelBackend,
        budgetPaused,
        finalText,
        trace: completedTrace,
        visibleChatSessionId: readDeepSeekChatSessionId(location.pathname),
      });
    }
  } catch (err) {
    console.error("[DeepSeek++] handleAgentLoopComplete error:", err);
  } finally {
    // Clear the live bookkeeping synchronously. The DOM stays visible while
    // the terminal write settles, so a persistence failure leaves the user
    // with the completed extension-owned answer instead of a blank screen.
    stopAgentConsoleTimer();
    pendingAgentReasoningByStep.clear();
    inlineAgentLoopId = null;
    inlineAgentContainer = null;
    inlineAgentCurrentStep = null;
    activeInlineAgentTrace = null;
    inlineAgentContainerObserver?.disconnect();
    inlineAgentContainerObserver = null;
  }

  if (!completedTrace) return false;
  try {
    // This awaited write is the commit barrier. The caller closes the tool
    // authorization after this promise resolves and only then reloads.
    await persistInlineAgentTraceImmediately(completedTrace);
  } catch {
    return false;
  }
  if (shouldReloadNativeHistory) {
    // The reload discards this world, so the log handoff must settle while the
    // extension context is still alive.
    await persistConsoleLogBufferBeforeReload();
  }
  return shouldReloadNativeHistory;
}

/**
 * Restored step text extraction: historical traces (clamped mid-output) go
 * through the same retired-protocol + tool-call stripping as live step text;
 * their `...[truncated]` clamp marker is preserved for the answer resolver's
 * same-origin comparison.
 */
function getInlineAgentRestoredStepText(text: string): string {
  return getInlineAgentDisplayStepText(text, currentToolDescriptors);
}

/**
 * Appends a narration segment (markdown body) to the agent stream — used for
 * final answers that are not the last step's own text (budget notices, legacy
 * summary-split runs) and for restored answers.
 */
function appendInlineAgentNarration(
  container: HTMLElement,
  text: string,
  loopId: string,
): void {
  // P0-2: 同一 loopId 的 narration 只渲染一次（模块级幂等守卫）。
  if (!shouldRenderNarration(loopId)) return;
  const renderText = clampText(text, INLINE_AGENT_FINAL_RENDER_MAX_CHARS) ?? "";
  if (!renderText) return;
  const stream = getAgentConsoleBody(container);
  if (!stream) return;

  const narration = document.createElement("div");
  narration.className = "dpp-agent-step dpp-agent-narration";
  narration.setAttribute("data-dpp-agent-loop-id", loopId);

  const body = document.createElement("div");
  body.className = "dpp-agent-step-body";
  body.setAttribute("data-dpp-raw-text", renderText);
  body.innerHTML = renderAgentStreamText(renderText);

  narration.appendChild(body);
  stream.appendChild(narration);
  // Keep the scroller pinned while the final answer streams in (the reader is
  // watching the bottom; a scrolled-up reader is never yanked).
  followAgentStreamBottom(stream);
}

function handleAgentLoopError(msg: InlineAgentLoopErrorMsg): void {
  if (msg.loopId !== inlineAgentLoopId || !inlineAgentContainer) return;
  stopAgentConsoleTimer();
  removeAgentStartingElement();
  flushPendingInlineAgentStreamRender();

  try {
    if (inlineAgentCurrentStep) {
      updateStepStatus(inlineAgentCurrentStep, "error");
    }
    const stream = getAgentConsoleBody(inlineAgentContainer);
    if (stream) finalizePendingAgentToolEntries(stream);

    renderTerminalAgentConsoleHeader(
      inlineAgentContainer,
      "error",
      msg.stepIndex,
      msg.totalTools,
      msg.error,
    );
    updateActiveInlineAgentTrace(
      (trace) => ({
        ...trace,
        status: "error",
        totalSteps: msg.stepIndex,
        error: msg.error,
      }),
      { immediate: true },
    );
  } catch (err) {
    console.error("[DeepSeek++] handleAgentLoopError:", err);
  } finally {
    stopAgentConsoleTimer();
    inlineAgentLoopId = null;
    inlineAgentContainer = null;
    inlineAgentCurrentStep = null;
    activeInlineAgentTrace = null;
    inlineAgentContainerObserver?.disconnect();
    inlineAgentContainerObserver = null;
  }
}

function runToolExecution(call: ToolCall): Promise<ToolCardResult> {
  const session = getOrCreateActiveToolBlockSession(call);
  if (activeStreamingToolCount > 0) activeStreamingToolCount--;
  const task = (async () => {
    if (isExternalizedToolPayloadCall(call)) {
      await waitForExternalToolPayloadWrites(call);
    }
    return executeToolCall(call);
  })()
    .catch((err): ToolCardResult => ({
      ok: false,
      summary: contentT("content.toolBlock.summaries.failed"),
      detail: err instanceof Error ? err.message : String(err),
    }))
    .then((result) => {
      removePendingToolExecution(session, call);
      const execution = {
        callId: call.id,
        name: result.name ?? call.name,
        result,
        provider: result.provider ?? call.provider,
        descriptorId: result.descriptorId ?? call.descriptorId,
      };
      // 2026-10-22 真机定位：同一个 call 的结果被追加了两次。
      // 证据是一条 634 KB 的块里 4 条执行变成了 8 条（18/5/14/279 KB
      // 各出现两遍），storage 因此翻倍，每次 upsert 的 JSON 往返也翻倍，
      // 叠加后把渲染进程压崩。
      //
      // 根因方向：session 是按 createToolRestoreBlockId 归并的，当 requestId /
      // chatSessionId 都缺失时两个不同的运行会落进同一个 `route:` 会话，
      // 于是各自的执行都追加到同一个数组里。这里按 callId 去重兜住。
      if (!session.executions.some((existing) => existing.callId === execution.callId)) {
        session.executions.push(execution);
      }
      activeToolBlockSessionId = session.id;
      toolExecutions = session.executions;
      renderToolBlock(session);
      observeReportedPersistence(persistToolBlockSession(session));
      showPetResult(result);
      return result;
    });

  pendingToolExecutionTasks.add(task);
  const requestId = call.source?.requestId;
  if (requestId) {
    const requestTasks =
      pendingToolExecutionTasksByRequest.get(requestId) ?? new Set();
    requestTasks.add(task);
    pendingToolExecutionTasksByRequest.set(requestId, requestTasks);
  }
  void task.finally(() => {
    pendingToolExecutionTasks.delete(task);
    if (!requestId) return;
    const requestTasks = pendingToolExecutionTasksByRequest.get(requestId);
    requestTasks?.delete(task);
    if (requestTasks?.size === 0)
      pendingToolExecutionTasksByRequest.delete(requestId);
  });
  return task;
}

function ensureToolCallId(call: ToolCall): ToolCall {
  if (call.id) return call;
  const identity = JSON.stringify({
    requestId: call.source?.requestId ?? null,
    descriptorId: call.descriptorId ?? null,
    providerId: call.provider?.id ?? null,
    name: call.name,
    invocationName: call.invocationName ?? null,
    raw: call.raw,
  });
  return { ...call, id: `legacy:${hashString(identity)}` };
}

function getToolAuthorizationForCall(
  call: ToolCall,
): ToolAuthorizationGrantSummary | undefined {
  const source = call.source;
  const requestId = source?.requestId;
  if (!requestId) return undefined;
  const agentRequestId =
    source?.trigger === "agent_run" && source.runId
      ? inlineAgentAuthorizationRequestKeys.get(source.runId)
      : undefined;
  const authoritativeRequestId =
    agentRequestId ??
    toolAuthorizationRequestAliases.get(requestId) ??
    (activeToolAuthorizations.has(requestId) ? requestId : undefined);
  return authoritativeRequestId
    ? activeToolAuthorizations.get(authoritativeRequestId)
    : undefined;
}

function showPendingToolExecution(call: ToolCall): void {
  const session = getOrCreateActiveToolBlockSession(call);
  if (
    session.executions.some((execution) =>
      isMatchingPendingToolExecution(execution, call),
    )
  )
    return;

  session.executions.push({
    callId: call.id,
    pending: true,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    result: {
      ok: true,
      summary: contentT("content.toolBlock.summaries.running"),
    },
  });
  session.updatedAt = Date.now();
  registerPendingToolStart(call, session);
  activeToolBlockSessionId = session.id;
  toolExecutions = session.executions;
  setPetState("working");
  activeStreamingToolCount++;
  renderToolBlock(session, { skipCleanup: true });
}

function removePendingToolExecution(
  session: ActiveToolBlockSession,
  call: ToolCall,
): void {
  const index = session.executions.findIndex((execution) =>
    isMatchingPendingToolExecution(execution, call),
  );
  if (index >= 0) {
    session.executions.splice(index, 1);
  }
  unregisterPendingToolStart(call);
}

function registerPendingToolStart(
  call: ToolCall,
  session: ActiveToolBlockSession,
): void {
  const requestId = call.source?.requestId;
  if (!requestId) return;
  pendingStartedToolCallsByRequest.set(
    requestId,
    createPendingToolStartKey(call),
    { call, session },
  );
}

function unregisterPendingToolStart(call: ToolCall): void {
  const requestId = call.source?.requestId;
  if (!requestId) return;
  pendingStartedToolCallsByRequest.delete(
    requestId,
    createPendingToolStartKey(call),
  );
}

function createPendingToolStartKey(call: ToolCall): string {
  return call.id ?? `${call.descriptorId ?? ""}:${call.name}:${call.raw}`;
}

async function finalizeInterruptedToolStarts(requestId: string): Promise<void> {
  const authoritativeRequestId = activeToolAuthorizations.has(requestId)
    ? requestId
    : (toolAuthorizationRequestAliases.get(requestId) ?? requestId);
  const pending = pendingStartedToolCallsByRequest.drain(
    authoritativeRequestId,
  );
  await finalizePendingToolStarts(pending);
}

async function finalizePendingToolStarts(
  pending: PendingStartedToolCall[],
): Promise<void> {
  for (const { call, session } of pending) {
    removePendingToolExecution(session, call);
    const result: ToolCardResult = {
      ok: false,
      summary: contentT("content.toolBlock.summaries.failed"),
      detail: contentT("tool.runtime.incomplete"),
      error: {
        code: INCOMPLETE_TOOL_CALL_ERROR_CODE,
        message: contentT("tool.runtime.incomplete"),
        retryable: false,
      },
    };
    session.executions.push({
      callId: call.id,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      result,
    });
    session.updatedAt = Date.now();
    activeStreamingToolCount = Math.max(0, activeStreamingToolCount - 1);
    activeToolBlockSessionId = session.id;
    toolExecutions = session.executions;
    renderToolBlock(session);
    await persistToolBlockSession(session);
    showPetResult(result);
  }
}

function isMatchingPendingToolExecution(
  execution: ToolExecutionRecord,
  call: ToolCall,
): boolean {
  if (!execution.pending) return false;
  if (call.id && execution.callId === call.id) return true;
  return (
    execution.name === call.name && execution.descriptorId === call.descriptorId
  );
}

function showPetResult(result: ToolCardResult): void {
  setPetState(result.ok ? "success" : "error");
  schedulePetIdle(PET_FEEDBACK_DELAY_MS);
}

async function waitForPendingToolExecutions(requestId?: string) {
  while (true) {
    const tasks = requestId
      ? pendingToolExecutionTasksByRequest.get(requestId)
      : pendingToolExecutionTasks;
    if (!tasks || tasks.size === 0) return;
    await Promise.allSettled(Array.from(tasks));
  }
}

function normalizeResponseCompletePayload(
  payload: unknown,
  fallbackText: unknown,
): ResponseCompletePayload {
  const value =
    payload && typeof payload === "object"
      ? (payload as Partial<ResponseCompletePayload>)
      : {};
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : "",
    text:
      typeof value.text === "string"
        ? value.text
        : typeof fallbackText === "string"
          ? fallbackText
          : "",
    originalPrompt:
      typeof value.originalPrompt === "string" ? value.originalPrompt : "",
    agentTaskPrompt:
      typeof value.agentTaskPrompt === "string" ? value.agentTaskPrompt : "",
    chatSessionId:
      typeof value.chatSessionId === "string" ? value.chatSessionId : null,
    parentMessageId:
      typeof value.parentMessageId === "number" ? value.parentMessageId : null,
    assistantMessageId:
      typeof value.assistantMessageId === "number"
        ? value.assistantMessageId
        : null,
      truncated: value.truncated === true,
    promptOptions: {
      modelType:
        typeof value.promptOptions?.modelType === "string"
          ? value.promptOptions.modelType
          : null,
      searchEnabled: value.promptOptions?.searchEnabled === true,
      thinkingEnabled: value.promptOptions?.thinkingEnabled === true,
      refFileIds: Array.isArray(value.promptOptions?.refFileIds)
        ? value.promptOptions.refFileIds.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    },
  };
}

function normalizeResponseTokenSpeedPayload(
  payload: unknown,
): ResponseTokenSpeedPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<ResponseTokenSpeedPayload>;
  const estimatedTokens = toFiniteNumber(value.estimatedTokens);
  const accumulatedTokens =
    value.accumulatedTokens === null
      ? null
      : toFiniteNumber(value.accumulatedTokens);
  const tokensPerSecond = toFiniteNumber(value.tokensPerSecond);
  const elapsedMs = toFiniteNumber(value.elapsedMs);
  const textLength = toFiniteNumber(value.textLength);

  if (
    estimatedTokens === null ||
    tokensPerSecond === null ||
    elapsedMs === null ||
    textLength === null
  ) {
    return null;
  }

  return {
    requestId:
      typeof value.requestId === "string" ? value.requestId : undefined,
    chatSessionId:
      typeof value.chatSessionId === "string" ? value.chatSessionId : null,
    assistantMessageId:
      typeof value.assistantMessageId === "number"
        ? value.assistantMessageId
        : null,
    active: value.active === true,
    estimatedTokens,
    accumulatedTokens,
    tokensPerSecond,
    elapsedMs,
    textLength,
    tokenSource: value.tokenSource === "server" ? "server" : "estimated",
    speedSource: value.speedSource === "server" ? "server" : "estimated",
    modelType: typeof value.modelType === "string" ? value.modelType : null,
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function updateTokenSpeedIndicator(progress: ResponseTokenSpeedPayload) {
  if (shouldIgnoreEmptyTokenSpeedProgress(progress, lastTokenSpeedProgress))
    return;
  tokenSpeedRouteKey = getTokenSpeedRouteKey();
  lastTokenSpeedProgress = progress;
  renderTokenSpeedIndicator(progress);
  recordUsageProgress(progress);
}

function createIdleTokenSpeedProgress(): ResponseTokenSpeedPayload {
  return {
    requestId: undefined,
    chatSessionId: null,
    assistantMessageId: null,
    active: false,
    estimatedTokens: 0,
    accumulatedTokens: null,
    tokensPerSecond: 0,
    elapsedMs: 0,
    textLength: 0,
    tokenSource: "estimated",
    speedSource: "estimated",
    modelType: null,
  };
}

function recordUsageProgress(progress: ResponseTokenSpeedPayload) {
  const requestId = progress.requestId;
  if (progress.active || !requestId) return;
  const totalTokens = progress.accumulatedTokens ?? progress.estimatedTokens;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;

  const signature = [
    Math.round(totalTokens),
    progress.tokenSource,
    Math.round(progress.tokensPerSecond * 100) / 100,
    progress.speedSource,
    progress.modelType ?? "",
    progress.assistantMessageId ?? "",
  ].join("|");

  void usageProgressWrites
    .persist(requestId, signature, async () => {
      await sendRuntimeMessageStrict({
        type: "RECORD_USAGE_TURN",
        payload: {
          id: requestId,
          recordedAt: Date.now(),
          source: "deepseek-web",
          chatSessionId: progress.chatSessionId ?? getCurrentChatSessionId(),
          assistantMessageId: progress.assistantMessageId ?? null,
          modelType: progress.modelType,
          totalTokens: Math.round(totalTokens),
          tokenSource: progress.tokenSource,
          tps: progress.tokensPerSecond,
          speedSource: progress.speedSource,
          elapsedMs: progress.elapsedMs,
          messageCount: 2,
        },
      });
    })
    .catch((error) => {
      console.error("[DeepSeek++] Failed to persist usage turn.", error);
    });
}

function renderTokenSpeedIndicator(
  progress: ResponseTokenSpeedPayload,
): boolean {
  const badge = ensureTokenSpeedIndicator();
  if (!badge) return false;

  const tokens = progress.accumulatedTokens ?? progress.estimatedTokens;
  const tokenText = formatTokenCount(tokens);
  const speed = formatTokenSpeed(progress.tokensPerSecond);
  badge.textContent = `${tokenText} tok · ${speed}`;
  badge.dataset.active = progress.active ? "true" : "false";
  badge.dataset.tokenSource = progress.tokenSource;
  badge.dataset.speedSource = progress.speedSource;
  badge.setAttribute(
    "aria-label",
    `Accumulated tokens ${tokenText}, token output speed ${speed}`,
  );
  badge.setAttribute(
    "title",
    contentT("content.tokenSpeed.title", {
      tokens: `${tokenText} tok`,
      speed,
      idle: progress.active ? "" : contentT("content.tokenSpeed.idleSuffix"),
      tokenSource:
        progress.tokenSource === "server"
          ? contentT("content.tokenSpeed.sourceServer")
          : contentT("content.tokenSpeed.sourceEstimated"),
      speedSource:
        progress.speedSource === "server"
          ? contentT("content.tokenSpeed.sourceServer")
          : contentT("content.tokenSpeed.sourceEstimated"),
    }),
  );
  return true;
}

function formatTokenCount(tokens: number): string {
  const safeTokens =
    Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  return new Intl.NumberFormat(currentContentLocale).format(safeTokens);
}

function formatTokenSpeed(tokensPerSecond: number): string {
  const safeRate =
    Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
      ? tokensPerSecond
      : 0;
  const value =
    safeRate >= 100 ? String(Math.round(safeRate)) : safeRate.toFixed(1);
  return `${value} tok/s`;
}

function startTokenSpeedIndicatorBootstrap() {
  stopTokenSpeedIndicatorBootstrap();
  tokenSpeedBootstrapAttempts = 0;
  scheduleTokenSpeedIndicatorBootstrap();
}

function stopTokenSpeedIndicatorBootstrap() {
  if (!tokenSpeedBootstrapTimer) return;
  clearTimeout(tokenSpeedBootstrapTimer);
  tokenSpeedBootstrapTimer = null;
}

function scheduleTokenSpeedIndicatorBootstrap() {
  if (tokenSpeedBootstrapTimer) return;

  tokenSpeedBootstrapTimer = setTimeout(
    () => {
      tokenSpeedBootstrapTimer = null;
      const rendered = renderTokenSpeedIndicator(lastTokenSpeedProgress);
      if (rendered) return;

      tokenSpeedBootstrapAttempts += 1;
      if (tokenSpeedBootstrapAttempts < TOKEN_SPEED_BOOTSTRAP_RETRY_LIMIT) {
        scheduleTokenSpeedIndicatorBootstrap();
      }
    },
    tokenSpeedBootstrapAttempts === 0 ? 0 : TOKEN_SPEED_BOOTSTRAP_RETRY_MS,
  );
}

function startTokenSpeedIndicatorMountSubscription(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
) {
  stopTokenSpeedIndicatorMountSubscription();
  const root = document.getElementById("root") ?? document.body;
  if (!root) return;

  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) =>
        tokenSpeedCapabilityScope === scope &&
        scope.active &&
        mutations.some(
          (mutation) =>
            mutation.type === "childList" && mutation.target === root,
        ),
      handle: scheduleTokenSpeedIndicatorMountRefresh,
    }),
  );
  scheduleTokenSpeedIndicatorMountRefresh();
}

function stopTokenSpeedIndicatorMountSubscription() {
  if (tokenSpeedMountTimer) {
    clearTimeout(tokenSpeedMountTimer);
    tokenSpeedMountTimer = null;
  }
}

function scheduleTokenSpeedIndicatorMountRefresh() {
  if (tokenSpeedMountTimer) return;

  tokenSpeedMountTimer = setTimeout(() => {
    tokenSpeedMountTimer = null;
    applyCurrentRouteChange();
    if (isTokenSpeedIndicatorMountedInConversation()) return;
    renderTokenSpeedIndicator(lastTokenSpeedProgress);
  }, TOKEN_SPEED_MOUNT_DEBOUNCE_MS);
}

function handleTokenSpeedRouteChange() {
  closeConversationExportMenuIfSessionChanged();
  scheduleMultimodalMediaMount();
  if (applyCurrentRouteChange()) {
    renderTokenSpeedIndicator(lastTokenSpeedProgress);
  }
}

function applyCurrentRouteChange(): boolean {
  const previousRouteKey = tokenSpeedRouteKey;
  const nextRouteKey = getTokenSpeedRouteKey();
  if (nextRouteKey === previousRouteKey) return false;
  handleMultimodalMediaRouteChange(previousRouteKey, nextRouteKey);
  tokenSpeedRouteKey = nextRouteKey;
  lastTokenSpeedProgress = createIdleTokenSpeedProgress();
  removeTokenSpeedIndicator();
  return true;
}

function handleToolBlockRouteChange() {
  const nextRouteKey = getTokenSpeedRouteKey();
  if (nextRouteKey === toolBlockRouteKey) return;
  toolBlockRouteKey = nextRouteKey;
  restoredToolRecords.clear();
  pendingRestoredToolRecordIds.clear();
  restoredInlineAgentTraces.clear();
  pendingRestoredInlineAgentTraceIds.clear();
  restoredRenderAttempts = 0;
  restoredInlineAgentRenderAttempts = 0;

  const activeSession = getActiveToolBlockSession();
  if (activeSession && !isToolBlockSessionOnCurrentRoute(activeSession)) {
    toolBlockEl = null;
    toolExecutions = [];
  }

  renderActiveToolBlockForCurrentRoute();
  const scope = toolCapabilityScope;
  if (scope) {
    const epoch = ++toolCapabilityEpoch;
    observeReportedPersistence(restorePersistedToolBlocks(scope, epoch));
  }
  const inlineScope = inlineAgentCapabilityScope;
  if (inlineScope) {
    const epoch = ++inlineAgentCapabilityEpoch;
    observeReportedPersistence(
      restorePersistedInlineAgentTraces(inlineScope, epoch),
    );
  }
  scheduleRenderRestoredToolBlocks();
}

function handleContentNavigation(): void {
  if (tokenSpeedCapabilityScope?.active) handleTokenSpeedRouteChange();
  if (toolCapabilityScope?.active) handleToolBlockRouteChange();
  window.dispatchEvent(new Event("dpp:navigation"));
}

function getTokenSpeedRouteKey(): string {
  if (typeof location === "undefined") return "";
  return `${location.pathname}${location.search}`;
}

function isTokenSpeedIndicatorMountedInConversation(): boolean {
  const sessionId = getCurrentChatSessionId();
  const previous = tokenSpeedEl?.previousElementSibling;
  return Boolean(
    tokenSpeedEl?.isConnected &&
    previous instanceof HTMLButtonElement &&
    previous.classList.contains(EXPORT_ACTION_CLASS) &&
    (!sessionId || previous.dataset.dppExportSessionId === sessionId),
  );
}

function removeTokenSpeedIndicator() {
  tokenSpeedEl?.remove();
  tokenSpeedEl = null;
}

function ensureTokenSpeedIndicator(): HTMLElement | null {
  injectTokenSpeedStyles();

  const anchorButton = findTokenStatsAnchorButton();
  if (!anchorButton) return null;

  if (
    tokenSpeedEl &&
    tokenSpeedEl.isConnected &&
    tokenSpeedEl.previousElementSibling === anchorButton
  ) {
    return tokenSpeedEl;
  }

  tokenSpeedEl?.remove();

  const badge = document.createElement("div");
  badge.id = TOKEN_SPEED_BADGE_ID;
  badge.className = "dpp-token-speed-badge";
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  anchorButton.insertAdjacentElement("afterend", badge);
  tokenSpeedEl = badge;
  return badge;
}

function findTokenStatsAnchorButton(): HTMLButtonElement | null {
  const sessionId = getCurrentChatSessionId();
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`.${EXPORT_ACTION_CLASS}`),
  )
    .filter((button) => {
      if (!isVisibleElement(button)) return false;
      return !sessionId || button.dataset.dppExportSessionId === sessionId;
    })
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });
  return buttons[buttons.length - 1] ?? null;
}

function injectTokenSpeedStyles() {
  if (document.getElementById(TOKEN_SPEED_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = TOKEN_SPEED_STYLE_ID;
  style.textContent = `
    .dpp-token-speed-badge {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      min-height: 20px;
      max-width: min(180px, 45vw);
      margin-left: 4px;
      padding: 2px 8px;
      border: 1px solid rgba(77, 107, 254, 0.18);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
      color: #4b5563;
      font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    body.dpp-theme-dark .dpp-token-speed-badge {
      border-color: rgba(125, 145, 255, 0.28);
      background: rgba(22, 26, 36, 0.86);
      color: #d1d7e6;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
    }

    .dpp-token-speed-badge[data-active='false'] {
      opacity: 0.72;
    }
  `;
  document.head.appendChild(style);
}

function clampText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return value;
  return value.length > maxLength
    ? value.slice(0, maxLength) + "\n...[truncated]"
    : value;
}

function syncToMainWorld(
  memories: Memory[],
  skills: Skill[],
  activePreset: SystemPromptPreset | null,
  modelType: ModelType,
  toolDescriptors: ToolDescriptor[],
  promptSettings: PromptInjectionSettings = currentPromptSettings,
  skillAutoActivation: SkillAutoActivationSettings = currentSkillAutoActivation,
) {
  currentMemories = memories;
  currentSkills = skills;
  currentActivePreset = activePreset;
  currentModelType = modelType;
  currentToolDescriptors = toolDescriptors;
  currentPromptSettings = normalizePromptInjectionSettings(promptSettings);
  currentSkillAutoActivation =
    normalizeSkillAutoActivationSettings(skillAutoActivation);
  toolOpenTagRe = buildToolOpenTagRegex(toolDescriptors);
  toolMarkerRe = buildToolMarkerRegex(toolDescriptors);
  const fallbackPromptDescriptors = toolDescriptors.filter(
    (descriptor) => !isMcpCapabilityDescriptor(descriptor),
  );

  postToMainWorld({
    type: "SYNC_HOOK_STATE",
    // Catalog controls remain available to the content parser, but never
    // become fallback Prompt tools. A request receives them only through its
    // background-produced capability projection.
    toolDescriptors: fallbackPromptDescriptors,
    skillSummaries: skills
      .filter((skill) => skill.enabled !== false)
      .map((skill) => ({ name: skill.name, description: skill.description })),
    skillPopupCopy: {
      hint: contentT("content.skillPopup.hint"),
    },
  });
}

function decodeRuntimeMemories(value: unknown, path: string): Memory[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((memory, index) =>
    decodePersistedMemoryRecord(memory, `${path}[${index}]`),
  );
}

function syncCurrentRuntimeStateToMainWorld(): void {
  syncToMainWorld(
    currentMemories,
    currentSkills,
    currentActivePreset,
    currentModelType,
    currentToolDescriptors,
    currentPromptSettings,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Raised only when the background *sent back* a catalog that violates the
 * released contract. That is untrusted-shape data, so the fail-closed path
 * (clearing the catalog) applies. A transport failure is a different case and
 * must not clear the last known good catalog.
 */
class ToolDescriptorContractError extends Error {}

function decodeToolDescriptors(value: unknown): ToolDescriptor[] {
  if (!Array.isArray(value) || !value.every(isToolDescriptorRecord)) {
    throw new ToolDescriptorContractError(
      "Runtime tool descriptor catalog does not match the released contract.",
    );
  }
  return value as unknown as ToolDescriptor[];
}

function isToolDescriptorContractError(error: unknown): boolean {
  return error instanceof ToolDescriptorContractError;
}

function reportToolDescriptorSyncFailure(error: unknown): void {
  console.error(
    "[DeepSeek++] tool descriptor sync failed; tool execution disabled",
    error,
  );
  syncToMainWorld(
    currentMemories,
    currentSkills,
    currentActivePreset,
    currentModelType,
    [],
    currentPromptSettings,
  );
}

/**
 * The MV3 service worker can be reclaimed at any moment, and a message sent
 * while it is waking fails with "Receiving end does not exist". That is a
 * transient transport error, not a bad catalog: clearing the descriptors here
 * turned every SW restart into "tool execution disabled" until the next sync.
 * Keep the last known catalog and retry with bounded backoff instead.
 */
function retainToolDescriptorsAfterTransportFailure(error: unknown): void {
  console.warn(
    "[DeepSeek++] tool descriptor request failed; keeping last known catalog",
    error,
  );
}

function clearToolDescriptorRetry(): void {
  toolDescriptorRetryAttempts = 0;
  if (toolDescriptorRetryTimer !== null) {
    clearTimeout(toolDescriptorRetryTimer);
    toolDescriptorRetryTimer = null;
  }
}

function scheduleToolDescriptorRetry(isCurrent: () => boolean): void {
  if (toolDescriptorRetryTimer !== null) return;
  if (toolDescriptorRetryAttempts >= TOOL_DESCRIPTOR_RETRY_MAX_ATTEMPTS) {
    console.error(
      "[DeepSeek++] tool descriptor retry budget exhausted; tools unavailable until the next sync",
    );
    return;
  }
  const delay = Math.min(
    TOOL_DESCRIPTOR_RETRY_BASE_MS * 2 ** toolDescriptorRetryAttempts,
    TOOL_DESCRIPTOR_RETRY_MAX_MS,
  );
  toolDescriptorRetryAttempts += 1;
  toolDescriptorRetryTimer = window.setTimeout(() => {
    toolDescriptorRetryTimer = null;
    if (!isCurrent() || !hasLiveExtensionContext()) return;
    void refreshToolDescriptorsFromBackground(isCurrent);
  }, delay);
}

function buildToolOpenTagRegex(descriptors: ToolDescriptor[]): RegExp {
  const pattern = buildToolTagPattern(descriptors);
  return new RegExp(`<\\s*(${pattern})\\s*>`, "i");
}

function buildToolMarkerRegex(descriptors: ToolDescriptor[]): RegExp {
  const pattern = buildToolTagPattern(descriptors);
  return new RegExp(`<\\s*/?\\s*(?:${pattern})\\s*>`, "i");
}

function buildToolTagPattern(descriptors: ToolDescriptor[]): string {
  const catalogNames = createToolInvocationCatalog(descriptors).invocationNames;
  const escaped = [...new Set(catalogNames)].map(escapeRegExp);
  return escaped.length > 0 ? escaped.join("|") : "(?!)";
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getToolBlockUrl(): string {
  return `${location.origin}${location.pathname}${location.search}`;
}

function getToolBlockUrlForChatSession(
  chatSessionId: string | null | undefined,
): string {
  return createToolRestoreBlockUrl({
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    chatSessionId,
  });
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, "").trim();
}

function getInlineAgentAnchorContent(
  complete: ResponseCompletePayload,
): string {
  return stripToolCalls(complete.text, {
    descriptors: currentToolDescriptors,
  }).trim();
}

function createInlineAgentTrace(
  complete: ResponseCompletePayload,
  loopId: string,
  initialExecutions: ToolExecutionRecord[],
  anchorMessageIndex: number | null,
  anchorContent: string,
): InlineAgentTraceRecord {
  const now = Date.now();
  return {
    id: hashString(
      `${complete.chatSessionId}\n${complete.assistantMessageId}\n${complete.agentTaskPrompt || complete.originalPrompt}`,
    ),
    loopId,
    chatSessionId: complete.chatSessionId!,
    anchorMessageId: complete.assistantMessageId!,
    anchorMessageIndex,
    anchorContent,
    url: getToolBlockUrlForChatSession(complete.chatSessionId),
    originalPrompt: complete.originalPrompt,
    agentTaskPrompt: complete.agentTaskPrompt,
    status: "running",
    steps: [],
    initialExecutions: initialExecutions.map((execution) =>
      sanitizeToolExecutionForRestoreStorage(execution),
    ),
    totalSteps: 0,
    totalTools: initialExecutions.length,
    finalText: "",
    createdAt: now,
    updatedAt: now,
  };
}

function getInlineAgentStepText(step: HTMLElement): string {
  const body = step.querySelector<HTMLElement>(".dpp-agent-step-body");
  return (
    body?.getAttribute("data-dpp-raw-text") ??
    body?.textContent ??
    ""
  ).trim();
}

/**
 * True when a step's rendered body text shares its origin with the run's
 * final answer: equality, or the step text is a prefix of the answer after
 * normalizing truncation markers (a step clamped mid-artifact carries
 * `...[truncated]` plus the salvage fence, the full answer does not). Only
 * then may the step narration be REPLACED by the full answer — keeping both
 * would duplicate the deliverable. Distinct step notes (budget-paused runs,
 * legacy summary-split traces) never match (Issue #551 redesign).
 */
function isInlineAgentStepTextTheFinalAnswer(
  stepText: string,
  answerText: string,
): boolean {
  if (!stepText || !answerText) return false;
  const normalizedStep = stripInlineAgentTruncationSuffix(stepText);
  const normalizedAnswer = stripInlineAgentTruncationSuffix(answerText);
  if (!normalizedStep || !normalizedAnswer) return false;
  return (
    normalizedStep === normalizedAnswer ||
    normalizedAnswer.startsWith(normalizedStep)
  );
}

/**
 * W29 观测接线（2026-10-21）。
 *
 * `core/trace/report.ts` 定义了 TraceEvent 与 renderTraceReport，但从来没人发过事件，
 * 「断流」问题因此长期无法定位。这里把消息流映射成事件流并挂到当前 trace 上。
 *
 * 关键取舍：turn.start 立即落盘，其余防抖。否则进程被杀时连「这一轮开始过」都查不到，
 * 而那正是 Bug B「连 trace 都没有」的取证前提。
 */
let activeTraceTracker: TurnTracker | null = null;

function syncTraceEvents(immediate: boolean): void {
  if (!activeTraceTracker || !activeInlineAgentTrace) return;
  const events = [...activeTraceTracker.snapshot()];
  updateActiveInlineAgentTrace((trace) => ({ ...trace, events }), { immediate });
}

function endTraceTracking(): void {
  setTraceEventSink(null);
  activeTraceTracker = null;
}

/**
 * 开始一轮 agent 运行的轨迹采集。
 *
 * `initialExecutions` 是触发这一轮的**原生 turn** 已经执行完的工具
 * （trace 记录里的 initialExecutions 字段）。真机验证发现：工具实际都在
 * 原生 turn 里执行，循环自身的 step.toolExecutions 是空的
 * （steps[0].tools === [] 而 totalTools === 1），所以必须在这里补发
 * tool.exec —— 否则报告里永远看不到工具执行那一行，而它恰恰是
 * 「工具执行出错」类问题最关键的证据。
 */
function beginTraceTracking(
  loopId: string,
  initialExecutions: readonly ToolExecutionRecord[] = [],
): void {
  endTraceTracking();
  activeTraceTracker = createTurnTracker({
    onChange: ({ event }) => {
      syncTraceEvents(event.t === "turn.start");
    },
  });
  setTraceEventSink((event) => {
    if (event.t === "continuation.decision") {
      activeTraceTracker?.continuationDecision(event.reason, event.triggered);
    } else if (event.t === "request.sent") {
      // P0-2 第 2.1 项：loop 侧（deepseek-stream-fn / official-api）在请求
      // 真正发出前 emit；此处补齐 turnId/timestamp 后入库。
      activeTraceTracker?.requestSent(event.bytes, event.powMs);
    }
  });
  activeTraceTracker.startTurn(`${loopId}:0`);
  for (const exec of initialExecutions) {
    // 耗时不可得（工具结果不带 durationMs），省略。
    activeTraceTracker.toolExec(exec.name, undefined, Boolean(exec.result?.ok));
  }
  activeTraceTracker.flushSse();
}

/** 进入下一步：先把上一步的 SSE 冲平并收尾（未收尾时标注 step_advanced）。 */
function advanceTraceTurn(loopId: string, stepIndex: number): void {
  if (!activeTraceTracker) return;
  activeTraceTracker.flushSse();
  if (!activeTraceTracker.currentTurnEnded) {
    activeTraceTracker.endTurn("step_advanced", false);
  }
  activeTraceTracker.startTurn(`${loopId}:${stepIndex}`);
}

/**
 * 一步完成：冲平 SSE。工具执行的 tool.exec 已在 executeTool 内带真实
 * durationMs 入库（P0-2 第 2.3 项），此处不再重复 emit。
 */
function flushTraceStep(_toolExecutions: readonly { name: string; result?: { ok?: boolean } }[]): void {
  if (!activeTraceTracker) return;
  activeTraceTracker.flushSse();
}

/**
 * 整轮结束：收尾、落盘、解绑。
 *
 * `finished` 的语义是「用户拿到东西了」：只有 finalized 且 finalText 非空才算完成。
 * 这样「aborted / 空文本」会渲染成 TRUNCATED ← 断在这里，正是 Bug A 的形态。
 */
function finishTraceRun(stopReason: string, hasFinalText: boolean): void {
  if (!activeTraceTracker) return;
  activeTraceTracker.flushSse();
  activeTraceTracker.endTurn(stopReason, stopReason === "finalized" && hasFinalText);
  syncTraceEvents(true);
  endTraceTracking();
}

function updateActiveInlineAgentTrace(
  updater: (trace: InlineAgentTraceRecord) => InlineAgentTraceRecord,
  options: { immediate?: boolean; persist?: boolean } = {},
): InlineAgentTraceRecord | null {
  if (!activeInlineAgentTrace) return null;

  activeInlineAgentTrace = {
    ...updater(activeInlineAgentTrace),
    updatedAt: Date.now(),
  };
  const updated = activeInlineAgentTrace;

  if (options.persist === false) return updated;
  if (options.immediate) {
    if (inlineAgentTraceWriteTimer) {
      clearTimeout(inlineAgentTraceWriteTimer);
      inlineAgentTraceWriteTimer = null;
    }
    observeReportedPersistence(writeInlineAgentTrace(updated));
    return updated;
  }

  scheduleInlineAgentTraceWrite(updated);
  return updated;
}

function upsertInlineAgentTraceStep(
  trace: InlineAgentTraceRecord,
  step: InlineAgentTraceStepRecord,
): InlineAgentTraceRecord {
  const existing = trace.steps.filter((item) => item.index !== step.index);
  const steps = [...existing, step].sort((a, b) => a.index - b.index);
  return {
    ...trace,
    steps,
    totalSteps: Math.max(trace.totalSteps, step.index + 1),
  };
}

function updateInlineAgentTraceStep(
  trace: InlineAgentTraceRecord,
  stepIndex: number,
  patch: Partial<InlineAgentTraceStepRecord>,
): InlineAgentTraceRecord {
  const current = trace.steps.find((step) => step.index === stepIndex) ?? {
    index: stepIndex,
    status: "streaming" as const,
    text: "",
    toolExecutions: [],
    responseMessageId: null,
    collapsed: false,
  };
  return upsertInlineAgentTraceStep(trace, {
    ...current,
    ...patch,
    index: stepIndex,
  });
}

function scheduleInlineAgentTraceWrite(trace: InlineAgentTraceRecord): void {
  if (inlineAgentTraceWriteTimer) clearTimeout(inlineAgentTraceWriteTimer);
  inlineAgentTraceWriteTimer = setTimeout(() => {
    inlineAgentTraceWriteTimer = null;
    const latest =
      activeInlineAgentTrace?.id === trace.id ? activeInlineAgentTrace : trace;
    observeReportedPersistence(writeInlineAgentTrace(latest));
  }, INLINE_AGENT_TRACE_WRITE_DEBOUNCE_MS);
}

async function persistInlineAgentTraceImmediately(
  trace: InlineAgentTraceRecord,
): Promise<void> {
  if (inlineAgentTraceWriteTimer) {
    clearTimeout(inlineAgentTraceWriteTimer);
    inlineAgentTraceWriteTimer = null;
  }
  await writeInlineAgentTrace(trace);
}

async function writeInlineAgentTrace(
  trace: InlineAgentTraceRecord,
): Promise<void> {
  const stored = sanitizeInlineAgentTraceForStorage(trace);
  await contentPersistenceTracker.track(
    pendingInlineAgentPersistenceOperations,
    "inline-agent trace write",
    upsertPersistedInlineAgentTrace(stored),
  );
  if (inlineAgentCapabilityScope?.active)
    restoredInlineAgentTraces.set(stored.id, stored);
}

async function getPersistedInlineAgentTraces(): Promise<
  InlineAgentTraceRecord[]
> {
  return contentPersistenceTracker.track(
    pendingInlineAgentPersistenceOperations,
    "inline-agent trace read",
    readPersistedInlineAgentTraces(),
  );
}

function sanitizeInlineAgentTraceForStorage(
  trace: InlineAgentTraceRecord,
): InlineAgentTraceRecord {
  return {
    ...trace,
    originalPrompt:
      clampText(trace.originalPrompt, INLINE_AGENT_STEP_RENDER_MAX_CHARS) ?? "",
    agentTaskPrompt:
      clampText(trace.agentTaskPrompt, INLINE_AGENT_STEP_RENDER_MAX_CHARS) ??
      "",
    anchorContent: clampText(
      trace.anchorContent,
      INLINE_AGENT_STEP_RENDER_MAX_CHARS,
    ),
    finalText:
      clampText(trace.finalText, INLINE_AGENT_FINAL_RENDER_MAX_CHARS) ?? "",
    error: clampText(trace.error, 2000),
    initialExecutions: trace.initialExecutions?.map((execution) =>
      sanitizeToolExecutionForRestoreStorage(execution),
    ),
    steps: trace.steps.map(sanitizeInlineAgentTraceStep),
  };
}

function sanitizeInlineAgentTraceStep(
  step: InlineAgentTraceStepRecord,
): InlineAgentTraceStepRecord {
  return {
    ...step,
    text: clampText(step.text, INLINE_AGENT_STEP_RENDER_MAX_CHARS) ?? "",
    toolExecutions: step.toolExecutions.map((execution) =>
      sanitizeToolExecutionForRestoreStorage(execution),
    ),
  };
}

async function restorePersistedInlineAgentTraces(
  scope: ContentResourceScope,
  epoch: number,
): Promise<void> {
  const url = getToolBlockUrl();
  const traces = await getPersistedInlineAgentTraces();
  if (!isInlineAgentEpochActive(scope, epoch)) return;
  let changed = false;

  for (const trace of traces) {
    if (
      !shouldTryRestoreInlineAgentTrace(trace, url) ||
      restoredInlineAgentTraces.has(trace.id)
    )
      continue;
    restoredInlineAgentTraces.set(
      trace.id,
      normalizeRestoredInlineAgentTrace(trace),
    );
    pendingRestoredInlineAgentTraceIds.add(trace.id);
    changed = true;
  }

  if (changed) scheduleRenderRestoredInlineAgentTraces();
}

function normalizeRestoredInlineAgentTrace(
  trace: InlineAgentTraceRecord,
): InlineAgentTraceRecord {
  const wasInterrupted = trace.status === "running";
  const finalText = typeof trace.finalText === "string" ? trace.finalText : "";
  return {
    ...trace,
    status: wasInterrupted ? "stopping" : trace.status,
    error: wasInterrupted ? contentT("content.agent.stopped") : trace.error,
    finalText: clampText(finalText, INLINE_AGENT_FINAL_RENDER_MAX_CHARS) ?? "",
    steps: trace.steps.map((step) => ({
      ...step,
      status:
        wasInterrupted && step.status === "streaming" ? "error" : step.status,
      collapsed: true,
      text: clampText(step.text, INLINE_AGENT_STEP_RENDER_MAX_CHARS) ?? "",
      toolExecutions: step.toolExecutions.map((execution) =>
        normalizeRestoredToolExecution(execution),
      ),
    })),
  };
}

function shouldTryRestoreInlineAgentTrace(
  trace: InlineAgentTraceRecord,
  currentUrl: string,
): boolean {
  if (trace.chatSessionId)
    return getCurrentChatSessionId() === trace.chatSessionId;
  return trace.url === currentUrl;
}

async function getPersistedToolBlocks(): Promise<PersistedToolBlock[]> {
  return contentPersistenceTracker.track(
    pendingToolPersistenceOperations,
    "tool execution block read",
    readPersistedToolExecutionBlocks(),
  );
}

function getOrCreateActiveToolBlockSession(
  call: ToolCall,
): ActiveToolBlockSession {
  const chatSessionId = call.source?.chatSessionId ?? null;
  const parentMessageId = call.source?.parentMessageId ?? null;
  const requestId = call.source?.requestId ?? null;
  if (!requestId && !chatSessionId) {
    const activeSession = getActiveToolBlockSession();
    if (
      activeSession &&
      !activeSession.requestId &&
      !activeSession.chatSessionId &&
      isToolBlockSessionOnCurrentRoute(activeSession)
    ) {
      return activeSession;
    }
  }

  const url = getToolBlockUrlForChatSession(chatSessionId);
  const id = createToolRestoreBlockId({
    requestId,
    chatSessionId,
    parentMessageId,
    fallbackUrl: url,
    fallbackSeed: call.raw,
  });

  const existing = activeToolBlockSessions.get(id);
  if (existing) return existing;

  const now = Date.now();
  const session: ActiveToolBlockSession = {
    id,
    url,
    chatSessionId,
    requestId,
    parentMessageId,
    content: "",
    executions: [],
    createdAt: now,
    updatedAt: now,
  };
  activeToolBlockSessions.set(id, session);
  return session;
}

/**
 * 按 complete 信息找回本轮的工具会话。
 *
 * 2026-10-22 修复「executions=0」：原来只按**一个**现算 id 精确查找，
 * 而 id 的三段式优先级（requestId → chatSessionId → route）在创建侧和
 * 完成侧拿到的字段并不总是一致：
 *   - 创建侧（工具调用）用 `requestId = call.source?.requestId`、
 *     `parentMessageId` 取调用时的值、`fallbackSeed = call.raw`（工具 XML）；
 *   - 完成侧用 `requestId = complete.requestId`、`parentMessageId = complete.parentMessageId`、
 *     `fallbackSeed = 提示词`。
 * 只要 complete 侧 requestId 为空（或 parentMessageId 不同），两边的 id 就会
 * 落进不同分支，精确查找必然 miss，只能回退 activeToolBlockSessionId ——
 * 而它在某些路径上已被清空（:1469 / :1481 / :7165），于是
 * `completedExecutions` 变成空数组，agent 直接跳过启动、什么都不留下。
 *
 * 真机证据：SW 诊断有 tool start/finished (ok)，而埋点显示
 * `agent_start:skipped:no_continuable_executions | executions=0`。
 *
 * 现在按候选 id 列表依次尝试，全部 miss 再走「当前路由」与 activeId 回退。
 */
function getActiveToolBlockSessionForComplete(
  complete: ResponseCompletePayload,
): ActiveToolBlockSession | null {
  const chatSessionId = complete.chatSessionId;
  const url = getToolBlockUrlForChatSession(chatSessionId);
  const requestId = complete.requestId || null;

  // 候选 id：覆盖创建侧可能采用的各种字段组合。
  // 用共享 helper 而不是本地重算，避免两侧 hash 逻辑漂移。
  const candidates = createToolRestoreBlockIdCandidates({
    requestId,
    chatSessionId,
    parentMessageId: complete.parentMessageId,
    fallbackUrl: url,
    fallbackSeed: complete.agentTaskPrompt || complete.originalPrompt,
  });

  const byId = candidates
    .map((id) => activeToolBlockSessions.get(id))
    .find((session): session is ActiveToolBlockSession => Boolean(session)) ?? null;

  // 2026-10-22 补齐 ② 里明确标注的缺口：若创建侧用了 requestId 而完成侧
  // requestId 为空/不同，request 分支的 id 无法从完成侧反推。这里直接按
  // session 上记录的 requestId 反查，把这条路径也兜住。
  const byRequest = byId ? null : (requestId
    ? Array.from(activeToolBlockSessions.values())
      .find((s) => s.requestId && s.requestId === requestId) ?? null
    : null);

  // 全部 miss 时再按「当前路由上的会话」找——route 维度比单次 id 更稳。
  const byRoute = byId ? null : getCurrentRouteActiveToolBlockSession();
  const fallback = byId
    ? null
    : (byRequest ?? byRoute ?? (activeToolBlockSessionId
      ? (activeToolBlockSessions.get(activeToolBlockSessionId) ?? null)
      : null));
  const session = byId ?? fallback;

  // 2026-10-21 观测：真机出现「工具执行成功了，但 RESPONSE_COMPLETE 时
  // completedExecutions 是空数组」，导致 agent 直接跳过启动、什么都不留下。
  // 这里把「算了哪些 id / 哪个命中 / 各 session 的执行数」打出来，
  // 用于继续区分是 id 算错、还是 session 被提前清空。
  if (!byId) {
    recordAgentStartDecision(
      'session_lookup_missed',
      `tried=${candidates.length} byId=false reqHit=${Boolean(byRequest)} `
      + `routeHit=${Boolean(byRoute)} fallbackHit=${Boolean(fallback)} `
      + `activeId=${activeToolBlockSessionId ?? '(none)'} `
      + `sessions=${Array.from(activeToolBlockSessions.values())
        .map((s) => `${s.id.slice(0, 10)}:${s.executions.length}`)
        .join(',') || '(none)'} `
      + `reqId=${requestId ?? '(none)'} parentMsgId=${complete.parentMessageId ?? '(none)'}`,
    );
  }

  return session;
}

function getCurrentRouteActiveToolBlockSession(): ActiveToolBlockSession | null {
  for (const session of activeToolBlockSessions.values()) {
    if (isToolBlockSessionOnCurrentRoute(session)) return session;
  }
  return null;
}

function getActiveToolBlockSession(): ActiveToolBlockSession | null {
  return activeToolBlockSessionId
    ? (activeToolBlockSessions.get(activeToolBlockSessionId) ?? null)
    : null;
}

async function persistToolBlockSession(
  session: ActiveToolBlockSession,
  fullText?: string,
  complete?: ResponseCompletePayload,
) {
  if (session.executions.length === 0) return;

  const content = fullText
    ? stripToolCalls(fullText, { descriptors: currentToolDescriptors })
    : "";
  session.content = content || session.content;
  session.updatedAt = Date.now();
  const replayChatSessionId =
    session.chatSessionId ?? getCurrentChatSessionId();
  const regenerateScope =
    replayChatSessionId && complete?.assistantMessageId != null
      ? regenerateAuthorizationScopes.resolve(
          replayChatSessionId,
          complete.assistantMessageId,
        )
      : null;

  const block: PersistedToolBlock = {
    id: session.id,
    source: "storage",
    url: session.url,
    createdAt: session.createdAt,
    content: session.content,
    executions: session.executions.map((execution) =>
      sanitizeToolExecutionForRestoreStorage(execution),
    ),
    metadata: {
      requestId: session.requestId ?? "",
      chatSessionId: session.chatSessionId ?? "",
      parentMessageId: session.parentMessageId ?? null,
      assistantMessageId: complete?.assistantMessageId ?? null,
      toolCount: session.executions.length,
      mcpToolCount: session.executions.filter(
        (execution) => execution.provider?.kind === "mcp",
      ).length,
      updatedAt: session.updatedAt,
      ...(regenerateScope
        ? {
            [REGENERATE_AUTHORIZATION_METADATA_KEY]:
              createPersistedRegenerateAuthorizationMetadata(regenerateScope),
          }
        : {}),
    },
  };

  await contentPersistenceTracker.track(
    pendingToolPersistenceOperations,
    "tool execution block write",
    upsertPersistedToolExecutionBlock(block),
  );
  if (toolCapabilityScope?.active) {
    restoredToolRecords.set(block.id, block);
    pendingRestoredToolRecordIds.add(block.id);
    scheduleRenderRestoredToolBlocks();
  }
}

async function restorePersistedToolBlocks(
  scope: ContentResourceScope,
  epoch: number,
) {
  const url = getToolBlockUrl();
  const blocks = await getPersistedToolBlocks();
  if (!isToolEpochActive(scope, epoch)) return;
  rememberRestoredToolRecords(
    blocks
      .filter((block) => shouldTryRestoreToolBlock(block, url))
      .map((block) => ({ ...block, source: "storage" as const })),
  );
}

function shouldTryRestoreToolBlock(
  block: PersistedToolBlock,
  currentUrl: string,
): boolean {
  const chatSessionId = getToolRecordChatSessionId(block);
  if (chatSessionId) return getCurrentChatSessionId() === chatSessionId;
  if (isToolRecordOnCurrentRoute(block, currentUrl)) return true;

  try {
    return new URL(block.url).origin === location.origin;
  } catch {
    return false;
  }
}

function isToolRecordOnCurrentRoute(
  record: ToolCallRestoreRecord,
  currentUrl = getToolBlockUrl(),
): boolean {
  const chatSessionId = getToolRecordChatSessionId(record);
  if (chatSessionId) return getCurrentChatSessionId() === chatSessionId;
  return record.url === currentUrl;
}

function getToolRecordChatSessionId(
  record: ToolCallRestoreRecord,
): string | null {
  const metadataSessionId = record.metadata?.chatSessionId;
  if (typeof metadataSessionId === "string" && metadataSessionId)
    return metadataSessionId;
  if (!record.url) return null;
  return getChatSessionIdFromUrl(record.url);
}

function getToolRecordAssistantMessageId(
  record: ToolCallRestoreRecord,
): string | null {
  return firstMetadataId(
    record.metadata?.assistantMessageId,
    record.metadata?.messageId,
  );
}

function getToolRecordParentMessageId(
  record: ToolCallRestoreRecord,
): string | null {
  return firstMetadataId(record.metadata?.parentMessageId);
}

function firstMetadataId(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function getChatSessionIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, location.origin);
    const match = parsed.pathname.match(/\/(?:a\/)?chat\/s\/([^/?#]+)/);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function rememberRestoredToolRecords(
  records: ToolCallRestoreRecord[] | undefined,
) {
  if (!records || records.length === 0) return;

  let changed = false;
  for (const record of records) {
    if (!record.id) continue;

    const compatibleId = findCompatibleRestoredToolRecordId(record);
    if (compatibleId) {
      const existing = restoredToolRecords.get(compatibleId)!;
      restoredToolRecords.set(
        compatibleId,
        mergeToolRestoreRecords(existing, record),
      );
      pendingRestoredToolRecordIds.add(compatibleId);
      changed = true;
      continue;
    }

    if (restoredToolRecords.has(record.id)) continue;
    restoredToolRecords.set(record.id, record);
    pendingRestoredToolRecordIds.add(record.id);
    changed = true;
  }

  if (changed) {
    scheduleRenderRestoredToolBlocks();
    scheduleRenderRestoredInlineAgentTraces();
  }
}

function findCompatibleRestoredToolRecordId(
  record: ToolCallRestoreRecord,
): string | null {
  for (const [id, existing] of restoredToolRecords) {
    if (isCompatibleToolRestoreRecord(existing, record)) return id;
  }
  return null;
}

function isCompatibleToolRestoreRecord(
  a: ToolCallRestoreRecord,
  b: ToolCallRestoreRecord,
): boolean {
  const aMessageId = getToolRecordAssistantMessageId(a);
  const bMessageId = getToolRecordAssistantMessageId(b);
  if (aMessageId && bMessageId && aMessageId === bMessageId) return true;

  const aParentId = getToolRecordParentMessageId(a);
  const bParentId = getToolRecordParentMessageId(b);
  if (
    aParentId &&
    bParentId &&
    aParentId === bParentId &&
    haveMatchingToolSignatures(a, b)
  )
    return true;

  const aContent = normalizeText(a.content);
  const bContent = normalizeText(b.content);
  return (
    aContent.length >= 12 &&
    bContent.length >= 12 &&
    (aContent.includes(bContent.slice(0, 80)) ||
      bContent.includes(aContent.slice(0, 80))) &&
    haveMatchingToolSignatures(a, b)
  );
}

function mergeToolRestoreRecords(
  existing: ToolCallRestoreRecord,
  incoming: ToolCallRestoreRecord,
): ToolCallRestoreRecord {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    source:
      existing.source === "storage" || incoming.source === "storage"
        ? "storage"
        : (existing.source ?? incoming.source),
    content: preferNonEmptyText(incoming.content, existing.content),
    calls: incoming.calls?.length ? incoming.calls : existing.calls,
    executions: incoming.executions?.length
      ? incoming.executions
      : existing.executions,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    },
  };
}

function preferNonEmptyText(
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return primary && normalizeText(primary).length > 0 ? primary : fallback;
}

function haveMatchingToolSignatures(
  a: ToolCallRestoreRecord,
  b: ToolCallRestoreRecord,
): boolean {
  const aSignature = getToolRecordSignature(a);
  const bSignature = getToolRecordSignature(b);
  if (!aSignature || !bSignature) return false;
  return aSignature === bSignature;
}

function getToolRecordSignature(record: ToolCallRestoreRecord): string | null {
  const calls = record.calls;
  if (calls?.length) {
    return calls
      .map(
        (call) =>
          `${call.provider?.id ?? ""}:${call.name}:${JSON.stringify(call.payload)}`,
      )
      .join("|");
  }
  const executions = record.executions;
  if (executions?.length) {
    return executions
      .map((execution) => `${execution.provider?.id ?? ""}:${execution.name}`)
      .join("|");
  }
  return null;
}

async function appendExternalToolPayloadChunk(
  chunk: ToolCallPayloadChunk,
): Promise<void> {
  const authorization = chunk.requestId
    ? getToolAuthorizationForCall({
        name: "external_payload",
        payload: {},
        raw: "",
        source: { trigger: "manual_chat", requestId: chunk.requestId },
      })
    : undefined;
  if (!authorization) {
    throw new Error(
      "Externalized tool payload has no active authorization context.",
    );
  }
  const pendingKey = `${authorization.id}:${chunk.id}`;
  const previous =
    pendingExternalToolPayloadWrites.get(pendingKey) ?? Promise.resolve();
  const next = chainExternalizedPayloadWrite(previous, async () => {
    await sendRuntimeMessageStrict({
      type: "APPEND_EXTERNAL_TOOL_PAYLOAD_CHUNK",
      payload: {
        authorizationId: authorization.id,
        callId: chunk.id,
        invocationName: chunk.invocationName,
        chunk: chunk.chunk,
      },
    });
  });
  pendingExternalToolPayloadWrites.set(pendingKey, next);
  await next;
}

async function waitForExternalToolPayloadWrites(call: ToolCall): Promise<void> {
  const authorization = getToolAuthorizationForCall(call);
  const pendingKey = authorization ? `${authorization.id}:${call.id}` : call.id;
  if (!pendingKey) return;
  const pending = pendingExternalToolPayloadWrites.get(pendingKey);
  if (!pending) return;
  try {
    await pending;
  } finally {
    pendingExternalToolPayloadWrites.delete(pendingKey);
  }
}

// M0 G1 外层包装：统一按最终结果记录工具调用成败，内层多出口控制流保持不动。
// 埋点自身失败由 recordToolCall 内部门控/降级兜底，不阻断工具主链路。
async function executeToolCall(
  call: ToolCall,
  authorizationId?: string,
): Promise<ToolCardResult> {
  try {
    const result = await executeToolCallInner(call, authorizationId);
    refactorTelemetry.recordToolCall(result.ok, result.error?.code);
    return result;
  } catch (error) {
    refactorTelemetry.recordToolCall(false, "exception");
    throw error;
  }
}

async function executeToolCallInner(
  call: ToolCall,
  authorizationId?: string,
): Promise<ToolCardResult> {
  if (call.parseError) {
    return {
      ok: false,
      summary: contentT("tool.runtime.invalidFormat"),
      detail: call.parseError.message,
      error: call.parseError,
    };
  }

  const grant = getToolAuthorizationForCall(call);
  const authorization = authorizationId ?? grant?.id;
  const executionCall = await bindNewChatToolCallToBrowserSession(
    call,
    grant?.chatSessionId,
    {
      readChatSessionId: getCurrentChatSessionId,
      signal: toolCapabilityScope?.signal,
    },
  );
  if (!executionCall) return createUnboundToolSessionResult(call);

  const result = await sendRuntimeToolCallMessage(executionCall, authorization);
  const normalized = normalizeRuntimeToolCallResult(result);

  if (normalized) {
    if (shouldRequestWebFetchPermission(executionCall, normalized)) {
      const url = executionCall.payload?.url;
      const granted =
        typeof url === "string" ? await requestWebFetchPermission(url) : false;
      if (granted) {
        const retryResult = await sendRuntimeToolCallMessage(
          executionCall,
          authorization,
        );
        const retryNormalized = normalizeRuntimeToolCallResult(retryResult);
        if (retryNormalized) return retryNormalized;
      }
    }
    return normalized;
  }

  if (!extensionContextValid) {
    return {
      ok: false,
      summary: contentT("content.toolBlock.summaries.failed"),
      detail: contentT("content.extensionReloaded"),
    };
  }
  return createInvalidRuntimeToolResult(executionCall, result);
}

function createUnboundToolSessionResult(call: ToolCall): ToolCardResult {
  const detail = contentT("tool.runtime.sessionBindingUnavailable");
  return {
    ok: false,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    summary: contentT("tool.runtime.authorizationRejected"),
    detail,
    error: {
      code: "tool_session_unavailable",
      message: detail,
      retryable: true,
    },
  };
}

async function sendRuntimeToolCallMessage(
  call: ToolCall,
  authorizationId?: string,
): Promise<unknown> {
  if (!hasLiveExtensionContext()) return undefined;

  try {
    return await chrome.runtime.sendMessage({
      type: "EXECUTE_TOOL_CALL",
      payload: { ...call, authorizationId },
    });
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      invalidateExtensionContext();
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: contentT("content.toolBlock.summaries.messageFailed"),
      detail,
      error: {
        code: "runtime_message_failed",
        message: detail,
        retryable: true,
      },
    };
  }
}

function normalizeRuntimeToolCallResult(value: unknown): ToolCardResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<ToolCardResult>;
  if (typeof result.ok !== "boolean" || typeof result.summary !== "string")
    return null;
  if (result.name !== undefined && typeof result.name !== "string") return null;
  if (
    result.descriptorId !== undefined &&
    typeof result.descriptorId !== "string"
  )
    return null;
  if (result.provider !== undefined && !isToolProviderIdentity(result.provider))
    return null;
  return {
    ok: result.ok,
    name: result.name,
    provider: result.provider,
    descriptorId: result.descriptorId,
    summary: result.summary,
    detail: result.detail,
    output: result.output,
    truncated: result.truncated,
    error: result.error,
  };
}

function createInvalidRuntimeToolResult(
  call: ToolCall,
  value: unknown,
): ToolCardResult {
  const missing = value === undefined || value === null;
  const message = missing
    ? "Background did not return a tool result."
    : `Background returned an invalid tool result: ${previewUnknown(value)}`;
  return {
    ok: false,
    summary: contentT("content.toolBlock.summaries.backgroundFailed"),
    detail: missing
      ? getMissingToolResultDetail(call)
      : contentT("content.toolBlock.invalidResultDetail", {
          preview: previewUnknown(value),
        }),
    error: {
      code: missing
        ? "runtime_tool_result_missing"
        : "runtime_tool_result_invalid",
      message,
      retryable: true,
    },
  };
}

function getMissingToolResultDetail(call: ToolCall): string {
  if (isSandboxRuntimeToolCall(call)) {
    return contentT("content.toolBlock.missingSandboxResultDetail");
  }
  if (isMcpRuntimeToolCall(call)) {
    return contentT("content.toolBlock.missingMcpResultDetail");
  }
  return contentT("content.toolBlock.missingResultDetail");
}

function isSandboxRuntimeToolCall(call: ToolCall): boolean {
  return (
    call.name === "sandbox_run" ||
    call.provider?.id === "sandbox" ||
    call.descriptorId?.startsWith("local:sandbox:") === true
  );
}

function isMcpRuntimeToolCall(call: ToolCall): boolean {
  return (
    call.provider?.kind === "mcp" ||
    call.descriptorId?.startsWith("mcp:") === true
  );
}

function previewUnknown(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text) return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    // Fall through to String(value).
  }
  const text = String(value);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

// --- Auto permission request for web_fetch ---

const PERMISSION_BANNER_ID = "dpp-permission-banner";
const PERMISSION_BANNER_STYLE_ID = "dpp-permission-banner-css";
const PERMISSION_BANNER_TIMEOUT_MS = 60_000;

interface ActivePermissionRequest {
  banner: HTMLElement;
  resolve: (granted: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

let activePermissionRequest: ActivePermissionRequest | null = null;

async function requestWebFetchPermission(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  finishActivePermissionRequest(false);
  const banner = createPermissionBanner(origin);
  if (!banner) return false;

  try {
    const granted = await new Promise<boolean>((resolve) => {
      const session: ActivePermissionRequest = {
        banner,
        resolve,
        timeoutId: null,
      };
      activePermissionRequest = session;

      const grantBtn = banner.querySelector<HTMLButtonElement>(
        ".dpp-permission-grant",
      );
      const denyBtn = banner.querySelector<HTMLButtonElement>(
        ".dpp-permission-deny",
      );
      if (!grantBtn || !denyBtn) {
        finishPermissionRequest(session, false);
        return;
      }

      const cleanup = (result: boolean) => {
        finishPermissionRequest(session, result);
      };
      session.timeoutId = setTimeout(
        () => cleanup(false),
        PERMISSION_BANNER_TIMEOUT_MS,
      );

      grantBtn.addEventListener(
        "click",
        async () => {
          grantBtn.textContent = contentT("content.permission.requesting");
          grantBtn.disabled = true;
          denyBtn.disabled = true;
          const permResult = await sendRuntimeMessage<{ ok: boolean }>({
            type: "REQUEST_HOST_PERMISSION",
            payload: { origins: [`${origin}/*`] },
          });
          cleanup(permResult?.ok === true);
        },
        { once: true },
      );

      denyBtn.addEventListener("click", () => cleanup(false), { once: true });
    });

    return granted;
  } finally {
    if (banner.isConnected) banner.remove();
  }
}

function finishActivePermissionRequest(granted: boolean): void {
  if (!activePermissionRequest) return;
  finishPermissionRequest(activePermissionRequest, granted);
}

function finishPermissionRequest(
  session: ActivePermissionRequest,
  granted: boolean,
): void {
  if (activePermissionRequest !== session) return;
  activePermissionRequest = null;
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }
  session.banner.remove();
  session.resolve(granted);
}

function createPermissionBanner(origin: string): HTMLElement | null {
  injectPermissionBannerStyles();

  const existing = document.getElementById(PERMISSION_BANNER_ID);
  if (existing) {
    finishActivePermissionRequest(false);
    existing.remove();
  }

  const banner = document.createElement("div");
  banner.id = PERMISSION_BANNER_ID;
  banner.className = "dpp-permission-banner";
  banner.innerHTML = `
    <span class="dpp-permission-text">${contentT(
      "content.permission.webFetch",
      {
        origin: `<strong>${escapeHtml(origin)}</strong>`,
      },
    )}</span>
    <div class="dpp-permission-actions">
      <button type="button" class="dpp-permission-deny">${contentT("content.permission.deny")}</button>
      <button type="button" class="dpp-permission-grant">${contentT("content.permission.grant")}</button>
    </div>
  `;

  const inputArea = findDeepSeekInputBox();
  const target = inputArea?.parentElement ?? document.body;
  target.appendChild(banner);
  return banner;
}

function injectPermissionBannerStyles() {
  injectInjectedThemeStyles();
  if (document.getElementById(PERMISSION_BANNER_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = PERMISSION_BANNER_STYLE_ID;
  style.textContent = `
    .dpp-permission-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      margin: 8px 12px;
      border-radius: 10px;
      background: var(--dpp-ui-surface);
      border: 1px solid var(--dpp-ui-accent);
      box-shadow: 0 2px 12px rgba(77, 107, 254, 0.15);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
      color: var(--dpp-ui-text);
      animation: dppPermFadeIn 0.2s ease-out;
      z-index: 100;
    }

    .dpp-permission-text {
      flex: 1;
      min-width: 0;
    }

    .dpp-permission-text strong {
      color: var(--dpp-ui-accent);
    }

    .dpp-permission-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .dpp-permission-actions button {
      padding: 5px 14px;
      border-radius: 8px;
      border: 1px solid var(--dpp-ui-border);
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .dpp-permission-deny {
      background: var(--dpp-ui-surface-muted);
      color: var(--dpp-ui-text-muted);
    }

    .dpp-permission-deny:hover {
      background: var(--dpp-ui-danger-panel);
      color: var(--dpp-ui-error);
      border-color: var(--dpp-ui-error);
    }

    .dpp-permission-grant {
      background: var(--dpp-ui-accent);
      color: #fff;
      border-color: var(--dpp-ui-accent);
    }

    .dpp-permission-grant:hover {
      opacity: 0.9;
    }

    .dpp-permission-grant:disabled,
    .dpp-permission-deny[disabled] {
      opacity: 0.5;
      cursor: pointer;
    }

    @keyframes dppPermFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

  `;
  document.head.appendChild(style);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// --- Tool execution collapsible block, aligned with the host reasoning block style. ---

function injectToolBlockStyles() {
  injectInjectedThemeStyles();
  if (document.getElementById(TOOL_BLOCK_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOOL_BLOCK_STYLE_ID;
  style.textContent = `
    .dpp-tool-block {
      margin-top: 8px;
    }
    .dpp-artifact-results {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dpp-artifact-results:empty {
      display: none;
    }
    .dpp-tool-block-header {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      color: var(--dpp-ui-text-muted);
      font-size: 12px;
      line-height: 18px;
    }
    .dpp-tool-block-header:hover {
      color: var(--dpp-ui-text);
    }
    .dpp-tool-block-icon {
      width: 16px;
      height: 16px;
      color: var(--dpp-ui-accent);
      flex-shrink: 0;
    }
    .dpp-tool-block-title {
      font-weight: 500;
      color: inherit;
    }
    .dpp-tool-block-chevron {
      width: 12px;
      height: 12px;
      color: inherit;
      transition: transform 0.2s ease;
      margin-left: 2px;
    }
    .dpp-tool-block[data-collapsed="true"] .dpp-tool-block-chevron {
      transform: rotate(-90deg);
    }
    .dpp-tool-block-body {
      overflow: hidden;
      transition: max-height 0.25s ease, opacity 0.2s ease;
      max-height: 500px;
      opacity: 1;
      padding-left: 20px;
      margin-top: 6px;
    }
    .dpp-tool-block[data-collapsed="true"] .dpp-tool-block-body {
      max-height: 0;
      opacity: 0;
      margin-top: 0;
    }
    .dpp-tool-block-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      margin: 2px 0;
      border: 1px solid var(--dpp-ui-border-muted);
      border-radius: 8px;
      background: var(--dpp-ui-surface-muted);
      font-size: 13px;
      color: var(--dpp-ui-text);
      line-height: 1.5;
    }
    .dpp-tool-block-dot {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--dpp-ui-accent);
    }
    .dpp-tool-block-item-text {
      flex: 1;
      min-width: 0;
    }
    .dpp-tool-block-item-name {
      font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--dpp-ui-accent);
    }
    .dpp-tool-block-item-status {
      color: var(--dpp-ui-success);
      margin-left: 6px;
    }
    .dpp-tool-block-item-status.error {
      color: var(--dpp-ui-error);
    }
    .dpp-tool-block-item-detail {
      margin-top: 4px;
      padding: 6px 8px;
      max-height: min(52vh, 420px);
      border-radius: 8px;
      background: var(--dpp-ui-accent-panel);
      color: var(--dpp-ui-text-muted);
      font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow: auto;
      overflow-wrap: anywhere;
      overscroll-behavior: contain;
    }
    .dpp-manual-continuation {
      margin: 10px 0 0 20px;
      padding: 10px 12px;
      border-left: 2px solid var(--dpp-ui-accent);
      border-radius: 6px;
      background: var(--dpp-ui-accent-panel);
      color: var(--dpp-ui-text);
      font-size: 14px;
      line-height: 1.65;
    }
    .dpp-manual-continuation.error {
      border-left-color: var(--dpp-ui-error);
      background: var(--dpp-ui-danger-panel);
    }
    .dpp-manual-continuation-title {
      margin-bottom: 6px;
      color: var(--dpp-ui-accent);
      font-size: 12px;
      font-weight: 600;
    }
    .dpp-manual-continuation.error .dpp-manual-continuation-title {
      color: var(--dpp-ui-error);
    }
    .dpp-manual-continuation-content {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;
  document.head.appendChild(style);
}

function createToolBlockShell(options?: {
  id?: string;
  restoreId?: string;
  collapsed?: boolean;
}): HTMLElement {
  const block = document.createElement("div");
  if (options?.id) block.id = options.id;
  if (options?.restoreId)
    block.setAttribute("data-dpp-tool-key", options.restoreId);
  block.className = "dpp-tool-block";
  block.setAttribute("data-collapsed", options?.collapsed ? "true" : "false");
  block.innerHTML = `
    <div class="dpp-tool-block-header">
      <svg class="dpp-tool-block-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      <span class="dpp-tool-block-title"></span>
      <svg class="dpp-tool-block-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="dpp-tool-block-body"></div>
  `;

  block
    .querySelector(".dpp-tool-block-header")!
    .addEventListener("click", () => {
      const collapsed = block.getAttribute("data-collapsed") === "true";
      block.setAttribute("data-collapsed", collapsed ? "false" : "true");
    });

  return block;
}

function updateToolBlockContent(
  block: HTMLElement,
  executions: ToolExecutionRecord[],
) {
  const count = executions.length;
  const title = block.querySelector(".dpp-tool-block-title")!;
  title.textContent = contentT("content.toolBlock.title", { count });

  const body = block.querySelector(".dpp-tool-block-body")!;
  body.innerHTML = "";
  for (const exec of executions) {
    const item = document.createElement("div");
    item.className = "dpp-tool-block-item";
    item.innerHTML = `
      <div class="dpp-tool-block-dot"></div>
      <div class="dpp-tool-block-item-text">
        <div>
          <span class="dpp-tool-block-item-name"></span>
          <span class="dpp-tool-block-item-status ${exec.result.ok ? "" : "error"}"></span>
        </div>
      </div>
    `;
    const nameEl = item.querySelector(".dpp-tool-block-item-name")!;
    const statusEl = item.querySelector(".dpp-tool-block-item-status")!;
    nameEl.textContent = formatToolExecutionName(exec);
    statusEl.textContent = exec.result.summary;
    const detail = formatToolResultDetail(exec.result);
    if (detail) {
      const detailEl = document.createElement("div");
      detailEl.className = "dpp-tool-block-item-detail";
      const rendered = isDetachedArtifactToolResult(exec.result)
        ? false
        : renderToolResultWithRegistry({
            target: detailEl,
            result: exec.result,
            locale: currentContentLocale,
            sendMessage: sendRuntimeMessage,
          });
      if (!rendered) detailEl.textContent = detail;
      item.querySelector(".dpp-tool-block-item-text")!.appendChild(detailEl);
    }
    body.appendChild(item);
  }
}

function formatToolResultDetail(result: ToolCardResult): string {
  if (result.detail) {
    if (!result.ok && looksLikeJson(result.detail)) {
      const extracted = extractReadableError(result.detail);
      if (extracted) return extracted;
    }
    return result.detail;
  }
  if (result.output === undefined) return "";
  return typeof result.output === "string"
    ? result.output
    : JSON.stringify(result.output, null, 2);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function extractReadableError(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      const texts = parsed
        .filter(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text",
        )
        .map((item: unknown) => (item as Record<string, unknown>).text)
        .filter((text: unknown): text is string => typeof text === "string");
      if (texts.length > 0) return texts.join("\n");
    }
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string") return parsed.message;
      if (typeof parsed.error === "string") return parsed.error;
      if (
        parsed.error &&
        typeof parsed.error === "object" &&
        typeof parsed.error.message === "string"
      ) {
        return parsed.error.message;
      }
    }
  } catch {
    /* not valid JSON, return null */
  }
  return null;
}

function formatToolExecutionName(exec: ToolExecutionRecord): string {
  if (exec.name === "python_exec")
    return contentT("content.toolBlock.pythonInterpreter");
  return exec.provider?.displayName
    ? `${exec.provider.displayName} / ${exec.name}`
    : exec.name;
}

function renderActiveToolBlockForCurrentRoute(): void {
  const session = getCurrentRouteActiveToolBlockSession();
  if (!session) return;

  activeToolBlockSessionId = session.id;
  toolExecutions = session.executions;
  renderToolBlock(session);
}

function isToolBlockSessionOnCurrentRoute(
  session: ActiveToolBlockSession,
): boolean {
  if (session.chatSessionId)
    return getCurrentChatSessionId() === session.chatSessionId;
  return session.url === getToolBlockUrl();
}

function renderToolBlock(
  session: ActiveToolBlockSession = getActiveToolBlockSession() ?? {
    id: "",
    url: getToolBlockUrl(),
    chatSessionId: getCurrentChatSessionId(),
    requestId: null,
    parentMessageId: null,
    content: "",
    executions: toolExecutions,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  options?: { skipCleanup?: boolean },
) {
  if (session.executions.length === 0) return;
  if (!isToolBlockSessionOnCurrentRoute(session)) return;

  injectToolBlockStyles();

  const existing = findRestoredToolBlock(session.id) as HTMLElement | null;
  if (existing) {
    toolBlockEl = existing;
  } else if (
    !toolBlockEl ||
    toolBlockEl.getAttribute("data-dpp-tool-key") !== session.id
  ) {
    toolBlockEl = createToolBlockShell({
      id: TOOL_BLOCK_ID,
      restoreId: session.id,
    });
  }

  if (!toolBlockEl.isConnected) {
    const block = toolBlockEl;
    placeToolBlock(
      block,
      () => isToolBlockSessionOnCurrentRoute(session),
      (message) =>
        renderDetachedArtifactResults(
          message,
          session.id,
          session.executions,
          block,
        ),
    );
  }

  if (!options?.skipCleanup) {
    cleanRenderedToolCalls();
  }
  updateToolBlockContent(toolBlockEl, session.executions);
  renderDetachedArtifactResultsForBlock(session, toolBlockEl);
}

function renderDetachedArtifactResultsForBlock(
  session: ActiveToolBlockSession,
  block: HTMLElement,
) {
  const message = block.closest(".ds-message");
  if (!message) return;
  renderDetachedArtifactResults(message, session.id, session.executions, block);
}

function renderDetachedArtifactResults(
  message: Element,
  sessionId: string,
  executions: ToolExecutionRecord[],
  beforeBlock?: HTMLElement,
) {
  const artifactExecutions = executions.filter(isDetachedArtifactExecution);
  const existing = findDetachedArtifactResults(message, sessionId);
  if (artifactExecutions.length === 0) {
    existing?.remove();
    return;
  }

  injectToolBlockStyles();
  const responseHost = getAssistantResponseHost(message);
  const container =
    existing ?? createDetachedArtifactResultsContainer(sessionId);
  container.innerHTML = "";
  for (const exec of artifactExecutions) {
    const item = document.createElement("div");
    item.className = "dpp-artifact-result-item";
    const rendered = renderToolResultWithRegistry({
      target: item,
      result: exec.result,
      locale: currentContentLocale,
      sendMessage: sendRuntimeMessage,
    });
    if (rendered) container.appendChild(item);
  }

  if (container.childElementCount === 0) {
    container.remove();
    return;
  }

  const anchor =
    beforeBlock && beforeBlock.parentElement === responseHost
      ? beforeBlock
      : null;
  if (!container.isConnected) {
    responseHost.insertBefore(container, anchor);
  } else if (anchor && container.nextSibling !== anchor) {
    responseHost.insertBefore(container, anchor);
  }
}

function createDetachedArtifactResultsContainer(
  sessionId: string,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "dpp-artifact-results";
  container.setAttribute("data-dpp-artifact-session-id", sessionId);
  return container;
}

function findDetachedArtifactResults(
  message: Element,
  sessionId: string,
): HTMLElement | null {
  const responseHost = getAssistantResponseHost(message);
  return (
    Array.from(
      responseHost.querySelectorAll<HTMLElement>(
        ":scope > .dpp-artifact-results",
      ),
    ).find(
      (container) =>
        container.getAttribute("data-dpp-artifact-session-id") === sessionId,
    ) ?? null
  );
}

function isDetachedArtifactExecution(execution: ToolExecutionRecord): boolean {
  return !execution.pending && isDetachedArtifactToolResult(execution.result);
}

function isDetachedArtifactToolResult(result: ToolCardResult): boolean {
  const output = result.output;
  return Boolean(
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    (output as Record<string, unknown>).kind === "artifact",
  );
}

function requeueRestoredToolRecordsForCurrentRoute(): void {
  for (const [id, record] of restoredToolRecords) {
    if (record.source !== "storage" || isToolRecordOnCurrentRoute(record)) {
      pendingRestoredToolRecordIds.add(id);
    }
  }
}

function requeueRestoredInlineAgentTracesForCurrentRoute(): void {
  const currentUrl = getToolBlockUrl();
  for (const [id, trace] of restoredInlineAgentTraces) {
    if (shouldTryRestoreInlineAgentTrace(trace, currentUrl)) {
      pendingRestoredInlineAgentTraceIds.add(id);
    }
  }
}

function scheduleRenderRestoredToolBlocks() {
  if (pendingRestoredToolRecordIds.size === 0) return;
  if (restoredRenderTimer) return;

  restoredRenderTimer = setTimeout(
    () => {
      restoredRenderTimer = null;
      const missing = renderRestoredToolBlocks();
      if (missing > 0 && restoredRenderAttempts < 20) {
        restoredRenderAttempts++;
        scheduleRenderRestoredToolBlocks();
        return;
      }
      restoredRenderAttempts = 0;
    },
    restoredRenderAttempts === 0 ? 0 : 250,
  );
}

function renderRestoredToolBlocks(): number {
  injectToolBlockStyles();

  const messages = getAssistantMessages();
  if (messages.length === 0) return pendingRestoredToolRecordIds.size;

  const usedMessages = new Set<Element>();

  for (const id of [...pendingRestoredToolRecordIds]) {
    const record = restoredToolRecords.get(id);
    if (!record) {
      pendingRestoredToolRecordIds.delete(id);
      continue;
    }
    // Agent-owned messages: the inline agent trace (live or restored) renders
    // the trigger turn's tools as the first agent tool group, so the legacy
    // tool block must never mount there — showing both would duplicate the
    // same executions in two visual styles (Issue: unified agent run record).
    if (isToolBlockRecordOwnedByAgentRun(record)) {
      pendingRestoredToolRecordIds.delete(id);
      continue;
    }
    const existingBlock = findRestoredToolBlock(
      record.id,
    ) as HTMLElement | null;
    if (existingBlock) {
      const executions = getRestoredExecutions(record);
      if (executions.length > 0) {
        updateToolBlockContent(existingBlock, executions);
        const target = existingBlock.closest(".ds-message");
        if (target)
          renderDetachedArtifactResults(
            target,
            record.id,
            executions,
            existingBlock,
          );
      }
      pendingRestoredToolRecordIds.delete(id);
      continue;
    }

    const target = findRestoredToolTarget(record, messages, usedMessages);
    if (!target) continue;

    const executions = getRestoredExecutions(record);
    if (executions.length === 0) {
      pendingRestoredToolRecordIds.delete(id);
      continue;
    }

    const block = createToolBlockShell({
      restoreId: record.id,
      collapsed: true,
    });
    updateToolBlockContent(block, executions);
    appendToolBlockToMessage(target, block);
    renderDetachedArtifactResults(target, record.id, executions, block);
    usedMessages.add(target);
    pendingRestoredToolRecordIds.delete(id);
  }

  cleanRenderedToolCalls();
  return pendingRestoredToolRecordIds.size;
}

function scheduleRenderRestoredInlineAgentTraces() {
  if (pendingRestoredInlineAgentTraceIds.size === 0) return;
  if (restoredInlineAgentRenderTimer) return;

  restoredInlineAgentRenderTimer = setTimeout(
    () => {
      restoredInlineAgentRenderTimer = null;
      const missing = renderRestoredInlineAgentTraces();
      if (missing > 0 && restoredInlineAgentRenderAttempts < 20) {
        restoredInlineAgentRenderAttempts++;
        scheduleRenderRestoredInlineAgentTraces();
        return;
      }
      restoredInlineAgentRenderAttempts = 0;
    },
    restoredInlineAgentRenderAttempts === 0 ? 0 : 250,
  );
}

function renderRestoredInlineAgentTraces(): number {
  injectInlineAgentStyles();

  const messages = getAssistantMessages();
  if (messages.length === 0) return pendingRestoredInlineAgentTraceIds.size;

  const usedMessages = new Set<Element>();

  for (const id of [...pendingRestoredInlineAgentTraceIds]) {
    const trace = restoredInlineAgentTraces.get(id);
    if (!trace) {
      pendingRestoredInlineAgentTraceIds.delete(id);
      continue;
    }
    if (findRestoredInlineAgentTrace(trace.id)) {
      pendingRestoredInlineAgentTraceIds.delete(id);
      continue;
    }
    if (trace.steps.length === 0) {
      pendingRestoredInlineAgentTraceIds.delete(id);
      continue;
    }

    const target = findRestoredInlineAgentTarget(trace, messages, usedMessages);
    if (!target) continue;

    const container = createRestoredInlineAgentContainer(trace);
    mountRestoredInlineAgentContainer(target, container, trace);
    usedMessages.add(target);
    pendingRestoredInlineAgentTraceIds.delete(id);
  }

  return pendingRestoredInlineAgentTraceIds.size;
}

function findRestoredInlineAgentTrace(id: string): Element | null {
  for (const container of document.querySelectorAll(
    ".dpp-agent-container[data-dpp-agent-trace-key]",
  )) {
    if (container.getAttribute("data-dpp-agent-trace-key") === id)
      return container;
  }
  return null;
}

function findRestoredInlineAgentTarget(
  trace: InlineAgentTraceRecord,
  messages: Element[],
  usedMessages: Set<Element>,
): Element | null {
  // Virtual-window-safe anchoring (Issue #551 follow-up): `messages` is only
  // the virtual list's rendered window, so index-based fallbacks
  // (`anchorMessageIndex`, tool-record `assistantMessageIndex`) point at the
  // WRONG message once the window moves — restored consoles mounted under
  // unrelated newer replies. Only DOM-id / own-text identity is trusted; when
  // the anchor message is not rendered this returns null and the trace stays
  // pending until its message scrolls into view (the mutation hub re-runs
  // the render). No mount is always better than a wrong mount.
  const anchorMessageId = String(trace.anchorMessageId);
  const toolContentHints: string[] = [];
  for (const record of restoredToolRecords.values()) {
    if (getToolRecordAssistantMessageId(record) !== anchorMessageId) continue;
    toolContentHints.push(record.content ?? "");
  }
  return findInlineAgentRestoreTarget(
    { anchorMessageId, anchorContent: trace.anchorContent ?? "" },
    toolContentHints,
    messages,
    usedMessages,
  );
}

function createRestoredInlineAgentContainer(
  trace: InlineAgentTraceRecord,
): HTMLElement {
  const container = createAgentContainer(undefined, getAgentRendererLabels());
  container.setAttribute("data-restored", "true");
  container.setAttribute("data-dpp-agent-trace-key", trace.id);
  container.setAttribute("data-dpp-agent-loop-id", trace.loopId);
  const consoleBody = getAgentConsoleBody(container);
  if (!consoleBody) return container;

  const restoredBudgetPaused =
    trace.status === "complete" &&
    isInlineAgentBudgetFinalText(trace.finalText, (count) =>
      contentT("content.agent.budgetReached", { count }),
    );
  const sortedSteps = [...trace.steps].sort((a, b) => a.index - b.index);
  const lastStepIndex =
    sortedSteps.length > 0 ? sortedSteps[sortedSteps.length - 1].index : null;
  const lastStepRecord =
    lastStepIndex === null ? null : sortedSteps[sortedSteps.length - 1];
  // Stream redesign (Issue #551): the restored answer is the run's full final
  // turn as the LAST narration segment — no separate answer area. New traces
  // persist the code-blockified finalText; older traces persisted a raw
  // summary/prefix (or the full raw turn) while the complete reply survived
  // solely in the last step, so the resolver compares the two same-origin
  // candidates with truncation markers normalized. A last step that IS the
  // answer is replaced in place; budget notices and legacy summary-split
  // traces keep their distinct step notes and append as a final segment.
  const finalDisplayText = getInlineAgentDisplayFinalText(
    trace.finalText,
    currentToolDescriptors,
  );
  const lastStepRenderText = lastStepRecord
    ? getInlineAgentRestoredStepText(lastStepRecord.text) || lastStepRecord.text
    : "";
  const restoredAnswer = restoredBudgetPaused
    ? { answer: finalDisplayText, fromStep: false }
    : resolveInlineAgentAnswerText(finalDisplayText, lastStepRenderText);
  const restoredAnswerText = restoredAnswer.answer;
  const lastStepIsAnswer =
    lastStepRecord !== null &&
    (restoredAnswer.fromStep ||
      isInlineAgentStepTextTheFinalAnswer(
        lastStepRenderText,
        restoredAnswerText,
      ));
  // A positive response id on the completed final step proves that the web
  // backend already committed this turn to DeepSeek history. The native
  // assistant message that follows the restored console owns both final
  // reasoning and final markdown; rendering them again here would duplicate
  // the answer after every refresh. Official-API and budget-paused traces keep
  // the extension-owned final narration.
  // 判据与 live **共用** traceOwnsFinalTurn。
  // 此前这里多一个 `lastStepRecord?.toolExecutions.length === 0`，导致同一轮
  // 「收尾时判原生拥有、刷新后判扩展拥有」—— 见 二次结论-根因定位-20261029.md §2.4。
  const nativeHistoryOwnsFinalTurn = traceOwnsFinalTurn(trace, {
    budgetPaused: restoredBudgetPaused,
  });

  let lastStepReplaced = false;
  // The trigger turn's tool executions (the legacy tool block is suppressed
  // for agent-owned messages): render them as the FIRST new-style tool group
  // so the restored run record keeps the full tool count in one visual flow.
  for (const exec of trace.initialExecutions ?? []) {
    resolveAgentToolEntry(consoleBody, -1, exec, getAgentRendererLabels());
  }
  for (const step of sortedSteps) {
    // 2.4 对齐：restore 侧也用三态动作 —— 末步带工具时**保留工具记录、只去掉答案正文**，
// 不再整步跳过（整步跳过会把工具历史一起丢掉）。
const restoreAction = decideRestoreStepAction({
  ownsFinalTurn: nativeHistoryOwnsFinalTurn,
  isLastStep: step.index === lastStepIndex,
  hasToolEntries: step.toolExecutions.length > 0,
});
if (restoreAction === 'skip') {
  continue;
}
    const stepEl = createAgentStepElement(step.index);
    const stepText = getInlineAgentRestoredStepText(step.text) || step.text;
    const renderStepText = restoreAction === 'render-without-answer'
  ? ""
  : (clampText(stepText, INLINE_AGENT_STEP_RENDER_MAX_CHARS) ?? "");
    const stepIsFinalAnswer = step.index === lastStepIndex && lastStepIsAnswer;
    if (renderStepText) {
      updateStepStreamText(
        stepEl,
        stepIsFinalAnswer ? restoredAnswerText : renderStepText,
      );
      refreshAgentStepCodeRunners(stepEl);
      mountAgentNarration(
        stepEl,
        consoleBody,
        getAgentRendererLabels(),
        step.reasoning,
      );
      if (stepIsFinalAnswer) lastStepReplaced = true;
    } else if (step.reasoning) {
      // Reasoning-only step (no narration text was persisted): mount the
      // textless step so the reasoning note has a home in the flow.
      mountAgentNarration(
        stepEl,
        consoleBody,
        getAgentRendererLabels(),
        step.reasoning,
      );
    }
    for (const exec of step.toolExecutions) {
      resolveAgentToolEntry(
        consoleBody,
        step.index,
        exec,
        getAgentRendererLabels(),
      );
    }
    // A mid-flight step (streaming / executing tools) persisted by a page
    // refresh can never resume: render it as interrupted instead of a frozen
    // blinking state with no stop control (Issue #544).
    if (step.status === "streaming" || step.status === "executing_tools") {
      updateStepStatus(stepEl, "interrupted");
    } else {
      updateStepStatus(stepEl, step.status);
    }
  }
  if (!nativeHistoryOwnsFinalTurn && !lastStepReplaced && restoredAnswerText) {
    appendInlineAgentNarration(container, restoredAnswerText, trace.loopId);
  }
  // A restored trace is a finished run: every tool group collapses to its
  // one-line header (Issue #551 redesign).
  collapseAllAgentToolGroups(consoleBody);

  const elapsedSeconds = Math.max(
    0,
    Math.floor((trace.updatedAt - trace.createdAt) / 1000),
  );
  if (trace.status === "complete") {
    // A budget-paused trace persists status 'complete' with the budget notice
    // as its final text; restore it as paused, not as a success (Issue #541).
    renderTerminalAgentConsoleHeader(
      container,
      restoredBudgetPaused ? "paused" : "complete",
      trace.totalSteps,
      trace.totalTools,
      undefined,
      elapsedSeconds,
    );
  } else if (trace.status === "error") {
    renderTerminalAgentConsoleHeader(
      container,
      "error",
      trace.totalSteps,
      trace.totalTools,
      trace.error,
      elapsedSeconds,
    );
  } else if (trace.status === "stopping") {
    renderTerminalAgentConsoleHeader(
      container,
      "paused",
      trace.totalSteps,
      trace.totalTools,
      trace.error ?? contentT("content.agent.stopped"),
      elapsedSeconds,
    );
  }

  return container;
}

function mountRestoredInlineAgentContainer(
  message: Element,
  container: HTMLElement,
  trace: InlineAgentTraceRecord,
): void {
  adoptMessageReasoningBlocks(message);
  // Defense against the restore race (tool-block read may finish before the
  // trace map is populated): the agent console owns the tool presentation of
  // its anchor message, so any legacy block mounted there is removed.
  removeToolBlockFromMessage(message);
  const host = getAssistantResponseHost(message);
  host.appendChild(container);
}

function findRestoredToolBlock(id: string): Element | null {
  for (const block of document.querySelectorAll(
    ".dpp-tool-block[data-dpp-tool-key]",
  )) {
    if (block.getAttribute("data-dpp-tool-key") === id) return block;
  }
  return null;
}

/**
 * True when a persisted tool block belongs to an inline-agent run's anchor
 * message: its `metadata.assistantMessageId` matches the live agent trace's
 * anchor, or any restored trace's anchor. The agent console owns the tool
 * presentation of those messages (the trigger turn's executions render as its
 * first tool group), so the legacy block must not mount.
 */
function isToolBlockRecordOwnedByAgentRun(
  record: ToolCallRestoreRecord,
): boolean {
  const rawAssistantMessageId = record.metadata?.assistantMessageId;
  if (rawAssistantMessageId === undefined || rawAssistantMessageId === null)
    return false;
  const assistantMessageId = Number(rawAssistantMessageId);
  if (!Number.isFinite(assistantMessageId)) return false;
  if (activeInlineAgentTrace?.anchorMessageId === assistantMessageId)
    return true;
  for (const trace of restoredInlineAgentTraces.values()) {
    if (trace.anchorMessageId === assistantMessageId) return true;
  }
  return false;
}

function getRestoredExecutions(
  record: ToolCallRestoreRecord,
): ToolExecutionRecord[] {
  if (record.executions?.length) {
    return record.executions.map((execution) =>
      normalizeRestoredToolExecution(execution),
    );
  }
  return (record.calls ?? []).map((call) => ({
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    result: summarizeRestoredToolCall(call),
  }));
}

function summarizeRestoredToolCall(call: ToolCall): ToolCardResult {
  const artifactResult = hasRestoreOmittedPayload(call.payload)
    ? null
    : createRestoredArtifactToolResult(call, currentContentLocale);
  if (artifactResult) {
    return {
      ok: artifactResult.ok,
      summary: artifactResult.summary,
      detail: artifactResult.detail,
      output: artifactResult.output,
      truncated: artifactResult.truncated,
      error: artifactResult.error,
    };
  }

  const payload = call.payload as Record<string, unknown>;
  const detail = getRestoredPayloadDetail(payload);

  switch (call.name) {
    case "memory_save":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.saved"),
        detail,
      };
    case "memory_update":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.updated"),
        detail,
      };
    case "memory_delete":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.deleted"),
        detail,
      };
    case "web_search":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.searched"),
        detail: String(
          typeof call.payload.query === "string" ? call.payload.query : "",
        ),
      };
    case "web_fetch":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.fetched"),
        detail: String(
          typeof call.payload.url === "string" ? call.payload.url : "",
        ),
      };
    case "artifact_create":
    case "artifact_bundle_create":
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.executed"),
        detail,
      };
    default:
      return {
        ok: true,
        summary: contentT("content.toolBlock.summaries.executed"),
        detail,
      };
  }
}

function getRestoredPayloadDetail(payload: Record<string, unknown>): string {
  const primary =
    payload.filename ?? payload.name ?? payload.content ?? payload.id ?? "";
  if (typeof primary === "string") return primary;

  const preview = getRestoreTruncatedPreview(primary);
  if (preview) return preview;

  return "";
}

function hasRestoreOmittedPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasRestoreOmittedPayload);

  const record = value as Record<string, unknown>;
  if (
    record.__dppRestoreTruncatedText === true ||
    typeof record.__dppRestoreOmittedItems === "number" ||
    typeof record.__dppRestoreOmittedKeys === "number" ||
    record.__dppRestoreMaxDepth === true
  ) {
    return true;
  }

  return Object.values(record).some(hasRestoreOmittedPayload);
}

function getRestoreTruncatedPreview(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const preview = (value as Record<string, unknown>).preview;
  return typeof preview === "string" ? preview : "";
}

/**
 * 收集页面上的 assistant 消息元素。
 *
 * 逻辑已抽到 `core/inline-agent/message-anchor.ts` 的
 * `collectAssistantMessages()`，这样可以在 jsdom 里单测退避路径；
 * 这里只是把 content.ts 的正文宿主选择器传进去。
 */
function getAssistantMessages(): Element[] {
  return collectAssistantMessages({
    contentSelector: ASSISTANT_RESPONSE_CONTENT_SELECTOR,
  });
}

function getAssistantResponseHost(message: Element): Element {
  const hosts = getAssistantContentHosts(message);
  if (hosts.length === 0) return message;

  // DeepSeek reuses the same content class for reasoning and final-answer blocks.
  const responseHosts = hosts.filter(
    (host) => !looksLikeReasoningContentHost(host),
  );
  return getLastElement(responseHosts) ?? getLastElement(hosts) ?? message;
}

function getAssistantContentHosts(message: Element): HTMLElement[] {
  return Array.from(
    message.querySelectorAll<HTMLElement>(ASSISTANT_RESPONSE_CONTENT_SELECTOR),
  ).filter(
    (host) => !host.parentElement?.closest(ASSISTANT_RESPONSE_CONTENT_SELECTOR),
  );
}

function looksLikeReasoningContentHost(host: HTMLElement): boolean {
  if (hasReasoningMetadata(host)) return true;

  const firstText = getFirstMeaningfulChildText(host);
  if (looksLikeReasoningLabelText(firstText)) return true;

  return hasReasoningAncestorLabel(host);
}

function getFirstMeaningfulChildText(host: Element): string {
  for (const child of Array.from(host.childNodes)) {
    const text = normalizeText(child.textContent ?? "");
    if (text) return text.slice(0, 80);
  }

  return normalizeText(host.textContent ?? "").slice(0, 80);
}

function hasReasoningAncestorLabel(host: HTMLElement): boolean {
  const boundary = host.closest(".ds-message");
  let ancestor = host.parentElement;
  let depth = 0;
  while (
    ancestor &&
    ancestor !== boundary &&
    depth < REASONING_HOST_ANCESTOR_SCAN_DEPTH
  ) {
    if (hasReasoningMetadata(ancestor)) return true;
    if (
      looksLikeReasoningLabelText(getFirstMeaningfulChildText(ancestor)) &&
      countContentHosts(ancestor) === 1
    ) {
      return true;
    }
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function hasReasoningMetadata(host: Element): boolean {
  const metadata = [
    host.className,
    host.getAttribute("aria-label") ?? "",
    host.getAttribute("data-testid") ?? "",
    host.getAttribute("data-role") ?? "",
  ].join(" ");
  return REASONING_HOST_META_RE.test(metadata);
}

function looksLikeReasoningLabelText(text: string): boolean {
  return REASONING_HOST_TEXT_RE.test(text);
}

function countContentHosts(root: Element): number {
  return root.querySelectorAll(ASSISTANT_RESPONSE_CONTENT_SELECTOR).length;
}

function getLastElement<T>(items: T[]): T | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function findRestoredToolTarget(
  record: ToolCallRestoreRecord,
  messages: Element[],
  usedMessages: Set<Element>,
): Element | null {
  const content = normalizeText(record.content);
  const snippet = content.slice(0, 80);
  const isSameRoute = isToolRecordOnCurrentRoute(record);

  const messageIdMatched = findRestoredToolTargetByMessageId(
    record,
    messages,
    usedMessages,
  );
  if (messageIdMatched) return messageIdMatched;

  if (snippet.length >= 12) {
    const matched = messages.find((message) => {
      if (usedMessages.has(message)) return false;
      return normalizeText(message.textContent ?? "").includes(snippet);
    });
    if (matched) return matched;
  }

  const indexed = findRestoredToolTargetByAssistantIndex(
    record,
    messages,
    usedMessages,
  );
  if (indexed) return indexed;

  if (!isSameRoute) return null;

  if (record.source === "storage") {
    return null;
  }

  return messages.find((message) => !usedMessages.has(message)) ?? null;
}

function findRestoredToolTargetByMessageId(
  record: ToolCallRestoreRecord,
  messages: Element[],
  usedMessages: Set<Element>,
): Element | null {
  const messageId = getToolRecordAssistantMessageId(record);
  if (!messageId) return null;

  return (
    messages.find((message) => {
      if (usedMessages.has(message)) return false;
      return elementHasMessageId(message, messageId);
    }) ?? null
  );
}

function findRestoredToolTargetByAssistantIndex(
  record: ToolCallRestoreRecord,
  messages: Element[],
  usedMessages: Set<Element>,
): Element | null {
  const assistantMessageIndex = getToolRecordAssistantMessageIndex(record);
  if (assistantMessageIndex === null) return null;

  const message = messages[assistantMessageIndex];
  if (!message || usedMessages.has(message)) return null;
  return message;
}

function getToolRecordAssistantMessageIndex(
  record: ToolCallRestoreRecord,
): number | null {
  const value = record.metadata?.assistantMessageIndex;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function startRenderedToolCallCleaner(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
) {
  stopRenderedToolCallCleaner();
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    if (activeStreamingToolCount > 0) return;
    scheduled = true;
    renderedToolCallCleanerFrame = requestAnimationFrame(() => {
      renderedToolCallCleanerFrame = null;
      scheduled = false;
      cleanRenderedToolCalls();
    });
  };

  schedule();

  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) => {
        if (toolCapabilityScope !== scope || !scope.active) return false;
        const restoreAction = getRestoredMessageMutationAction(mutations, {
          hasPendingRecords: pendingRestoredToolRecordIds.size > 0,
          restoredUiSelector: RESTORED_TOOL_UI_SELECTOR,
        });
        return (
          restoreAction.schedulePendingRender ||
          mutations.some(mutationMayContainCleanableText)
        );
      },
      handle(mutations) {
        const restoreAction = getRestoredMessageMutationAction(mutations, {
          hasPendingRecords: pendingRestoredToolRecordIds.size > 0,
          restoredUiSelector: RESTORED_TOOL_UI_SELECTOR,
        });
        if (restoreAction.requeueMountedRecords)
          requeueRestoredToolRecordsForCurrentRoute();
        schedule();
        if (
          restoreAction.schedulePendingRender &&
          pendingRestoredToolRecordIds.size > 0
        ) {
          restoredRenderAttempts = 0;
          scheduleRenderRestoredToolBlocks();
        }
      },
    }),
  );
}

function stopRenderedToolCallCleaner(): void {
  if (renderedToolCallCleanerFrame !== null) {
    cancelAnimationFrame(renderedToolCallCleanerFrame);
    renderedToolCallCleanerFrame = null;
  }
}

function mutationMayContainCleanableText(mutation: MutationRecord): boolean {
  if (mutation.type === "characterData") {
    return containsCleanableText(mutation.target.textContent);
  }

  for (const node of mutation.addedNodes) {
    if (addedNodeMayContainCleanableText(node)) {
      return true;
    }
  }

  return false;
}

function addedNodeMayContainCleanableText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return containsCleanableText(node.textContent);
  }

  if (!(node instanceof Element)) return false;
  if (
    node.closest(
      '.dpp-tool-block, .dpp-agent-container, script, style, textarea, input, [contenteditable="true"]',
    )
  ) {
    return false;
  }

  if (node.matches(".ds-message") || node.querySelector(".ds-message")) {
    return true;
  }

  return containsCleanableText(node.textContent);
}

function containsToolMarker(text: string | null | undefined): boolean {
  return (
    typeof text === "string" && text.includes("<") && toolMarkerRe.test(text)
  );
}

function containsCleanableText(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text) return false;
  if (isInlineAgentContinuationRenderedText(text)) return true;
  if (containsInternalPromptMarker(text)) return true;
  if (text.includes("<task_complete>") || text.includes("</task_complete>"))
    return true;
  if (text.includes(LEGACY_TOOL_CALLS_OPEN_TAG) || text.includes("｜DSML｜"))
    return true;
  if (!text.includes("<")) return false;
  if (hasLikelyToolMarkerPrefix(text)) return true;
  if (text.length > CLEANABLE_TEXT_DEEP_SCAN_MAX_CHARS) return false;
  return containsToolMarker(text);
}

function hasLikelyToolMarkerPrefix(text: string): boolean {
  return (
    text.includes("<memory_") ||
    text.includes("</memory_") ||
    text.includes("<web_") ||
    text.includes("</web_") ||
    text.includes("<artifact_") ||
    text.includes("</artifact_") ||
    text.includes("<skill_") ||
    text.includes("</skill_") ||
    text.includes("<mcp_") ||
    text.includes("</mcp_") ||
    text.includes("<python_") ||
    text.includes("</python_") ||
    text.includes("<shell_") ||
    text.includes("</shell_") ||
    text.includes("<local_") ||
    text.includes("</local_") ||
    text.includes("<task_complete>") ||
    text.includes("</task_complete>")
  );
}

function cleanRenderedToolCalls() {
  const roots = getToolCleanupRoots();
  for (const root of roots) {
    hideInlineAgentContinuationMessages(root);
    stripToolCallTextNodes(root);
  }
}

function startInlineAgentContinuationMessageHider(
  scope: ContentResourceScope,
  mutationHub: ContentMutationHub,
) {
  hideInlineAgentContinuationMessages(document);
  scope.addCleanup(
    "cleanup",
    mutationHub.subscribe({
      matches: (mutations) => {
        if (inlineAgentCapabilityScope !== scope || !scope.active) return false;
        const restoreAction = getRestoredMessageMutationAction(mutations, {
          hasPendingRecords: pendingRestoredInlineAgentTraceIds.size > 0,
          restoredUiSelector: RESTORED_INLINE_AGENT_UI_SELECTOR,
        });
        return (
          restoreAction.schedulePendingRender ||
          mutations.some(mutationMayContainInlineAgentContinuation)
        );
      },
      handle(mutations) {
        const restoreAction = getRestoredMessageMutationAction(mutations, {
          hasPendingRecords: pendingRestoredInlineAgentTraceIds.size > 0,
          restoredUiSelector: RESTORED_INLINE_AGENT_UI_SELECTOR,
        });
        if (restoreAction.requeueMountedRecords)
          requeueRestoredInlineAgentTracesForCurrentRoute();
        const roots = new Set<ParentNode>();
        for (const mutation of mutations) {
          if (mutation.type === "characterData") {
            const parent = mutation.target.parentElement;
            if (isInlineAgentContinuationRenderedText(parent?.textContent)) {
              const root = parent?.closest(".ds-message") ?? parent;
              if (root) roots.add(root);
            }
            continue;
          }

          for (const node of mutation.addedNodes) {
            if (node instanceof Element) roots.add(node);
          }
        }

        roots.forEach(hideInlineAgentContinuationMessages);
        if (
          restoreAction.schedulePendingRender &&
          pendingRestoredInlineAgentTraceIds.size > 0
        ) {
          restoredInlineAgentRenderAttempts = 0;
          scheduleRenderRestoredInlineAgentTraces();
        }
      },
    }),
  );
}

function stopInlineAgentContinuationMessageHider(): void {
  for (const message of document.querySelectorAll<HTMLElement>(
    '[data-dpp-hidden-inline-agent-continuation="true"]',
  )) {
    message.style.removeProperty("display");
    message.removeAttribute("data-dpp-hidden-inline-agent-continuation");
  }
}

function mutationMayContainInlineAgentContinuation(
  mutation: MutationRecord,
): boolean {
  if (mutation.type === "characterData") {
    return isInlineAgentContinuationRenderedText(mutation.target.textContent);
  }
  return [...mutation.addedNodes].some((node) =>
    nodeMatchesOrContains(node, ".ds-message"),
  );
}

function hideInlineAgentContinuationMessages(root: ParentNode) {
  const messages = getInlineAgentContinuationMessageCandidates(root);
  for (const message of messages) {
    if (!isInlineAgentContinuationRenderedText(message.textContent)) continue;
    message.setAttribute("data-dpp-hidden-inline-agent-continuation", "true");
    message.style.display = "none";
  }
}

function isInlineAgentContinuationRenderedText(
  text: string | null | undefined,
): boolean {
  if (typeof text !== "string" || !text) return false;
  // isInlineAgentContinuationStructure (tags only) is a strict superset of
  // isInlineAgentContinuationPrompt (tags + keywords), so the keyword check
  // is redundant here — the placeholder covers the history-restored case and
  // the structural check covers the live-rendered case.
  return (
    text.includes(INLINE_AGENT_CONTINUATION_PLACEHOLDER) ||
    isInlineAgentContinuationStructure(text)
  );
}

function getInlineAgentContinuationMessageCandidates(
  root: ParentNode,
): HTMLElement[] {
  const messages: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(".ds-message")) {
    messages.push(root);
  }
  if ("querySelectorAll" in root) {
    messages.push(
      ...Array.from(root.querySelectorAll<HTMLElement>(".ds-message")),
    );
  }
  return messages;
}

function getToolCleanupRoots(): Element[] {
  const roots = new Set<Element>();
  const activeMessage = toolBlockEl?.closest(".ds-message");
  if (activeMessage) roots.add(activeMessage);

  for (const block of document.querySelectorAll(
    `#${TOOL_BLOCK_ID}, .dpp-tool-block`,
  )) {
    const message = block.closest(".ds-message");
    if (message) roots.add(message);
  }

  const messages = document.querySelectorAll(".ds-message");
  const minIndex = Math.max(0, messages.length - CLEANUP_MESSAGE_SCAN_LIMIT);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i < minIndex) break;
    const message = messages[i];
    if (roots.has(message)) continue;
    if (containsCleanableText(message.textContent)) {
      roots.add(message);
    }
  }

  return Array.from(roots);
}

function stripToolCallTextNodes(root: Element) {
  if (!containsCleanableText(root.textContent)) return;

  const textNodes: Text[] = [];
  const changedParents = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        // A message already flagged as an inline-agent continuation bubble is
        // owned by hideInlineAgentContinuationMessages (which hides the whole
        // .ds-message). Letting strip touch it here can leave an empty shell
        // when DeepSeek re-renders and drops the display:none, so skip it.
        parent.closest("[data-dpp-hidden-inline-agent-continuation]") ||
        // Detached artifact cards live outside .dpp-tool-block but must be
        // exempt from tool-call text stripping just like the block itself.
        parent.closest(".dpp-tool-block, .dpp-artifact-results") ||
        parent.closest(
          'script, style, textarea, input, [contenteditable="true"]',
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  let activeTool: string | null = null;
  // Blank-line collapse across text nodes: model output separates tool calls
  // with `\n\n` on both sides. When the text before the open tag ended with a
  // newline, the text after the close tag must drop its own leading newlines,
  // otherwise stripping the XML leaves `\n\n\n\n` (the "blank line between
  // every row" rendering bug on the DeepSeek page).
  let stripTailLeadingNewlines = false;
  let lastNodeEndsWithNewline = false;

  for (const textNode of textNodes) {
    const original = textNode.nodeValue ?? "";
    if (!activeTool && !containsCleanableText(original)) {
      lastNodeEndsWithNewline = /\n$/.test(original);
      continue;
    }
    const sanitizedOriginal = sanitizeRenderedControlText(original, {
      replaceTaskComplete: shouldReplaceRenderedTaskCompleteBlock(textNode),
    });
    let cursor = 0;
    let next = "";

    while (cursor < sanitizedOriginal.length) {
      if (activeTool) {
        const closeRe = new RegExp(
          `<\\s*/\\s*${escapeRegExp(activeTool)}\\s*>`,
          "i",
        );
        const closeMatch = closeRe.exec(sanitizedOriginal.slice(cursor));
        if (!closeMatch) {
          cursor = sanitizedOriginal.length;
          break;
        }
        cursor += closeMatch.index + closeMatch[0].length;
        activeTool = null;
        continue;
      }

      const openMatch = toolOpenTagRe.exec(sanitizedOriginal.slice(cursor));
      if (!openMatch) {
        let rest = sanitizedOriginal.slice(cursor);
        if (stripTailLeadingNewlines) {
          rest = rest.replace(/^\n+/, "");
          stripTailLeadingNewlines = false;
        }
        next += rest;
        break;
      }

      let before = sanitizedOriginal.slice(cursor, cursor + openMatch.index);
      if (stripTailLeadingNewlines) {
        before = before.replace(/^\n+/, "");
        stripTailLeadingNewlines = false;
      }
      // Collapse excess blank lines right before the open tag down to a
      // single paragraph break (agent-mode output often wraps tool calls in
      // `\n\n\n`), matching the stream filter's behavior (Issue: agent panel
      // blank-line rendering).
      before = collapseRenderedExcessBlankLines(before);
      next += before;
      stripTailLeadingNewlines = /\n$/.test(next) || lastNodeEndsWithNewline;
      activeTool = openMatch[1];
      cursor += openMatch.index + openMatch[0].length;
    }

    next = collapseRenderedExcessBlankLines(next);
    if (next !== original) {
      textNode.nodeValue = next;
      if (textNode.parentElement) changedParents.add(textNode.parentElement);
    }
    lastNodeEndsWithNewline = /\n$/.test(next);
  }

  for (const parent of changedParents) {
    pruneEmptyToolContainers(parent, root);
  }
}

/**
 * Collapses runs of 3+ newlines outside fenced code blocks down to a single
 * paragraph break (`\n\n`). Keeps blank lines inside ``` fences intact for
 * `<pre>` rendering.
 */
function collapseRenderedExcessBlankLines(text: string): string {
  if (!text.includes("\n\n\n")) return text;
  if (!text.includes("```")) return text.replace(/\n{3,}/g, "\n\n");

  let output = "";
  let inFence = false;
  let cursor = 0;
  while (cursor < text.length) {
    const fenceIndex = text.indexOf("```", cursor);
    if (fenceIndex === -1) {
      output += inFence
        ? text.slice(cursor)
        : text.slice(cursor).replace(/\n{3,}/g, "\n\n");
      break;
    }
    const segment = text.slice(cursor, fenceIndex);
    output += inFence ? segment : segment.replace(/\n{3,}/g, "\n\n");
    output += "```";
    inFence = !inFence;
    cursor = fenceIndex + 3;
  }
  return output;
}

function sanitizeRenderedControlText(
  text: string,
  options: { replaceTaskComplete: boolean },
): string {
  const sanitized = sanitizeInternalPromptText(text);
  return options.replaceTaskComplete
    ? replaceTaskCompleteBlocks(sanitized)
    : sanitized;
}

function shouldReplaceRenderedTaskCompleteBlock(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) return false;
  if (parent.closest("pre, code")) return false;

  const message = parent.closest(".ds-message");
  if (!message) return false;
  return getAssistantContentHosts(message).some((host) =>
    host.contains(parent),
  );
}

function pruneEmptyToolContainers(start: HTMLElement, boundary: Element) {
  let el: HTMLElement | null = start;
  while (el && el !== boundary && !el.classList.contains("ds-message")) {
    const parent: HTMLElement | null = el.parentElement;
    const hasVisibleText = (el.textContent ?? "").trim().length > 0;
    const hasProtectedChild = Boolean(
      el.querySelector(
        ".dpp-tool-block, img, svg, canvas, video, button, input, textarea",
      ),
    );

    if (!hasVisibleText && !hasProtectedChild) {
      el.remove();
      el = parent;
      continue;
    }

    el = parent;
  }
}

function collapseToolBlock(block: HTMLElement | null = toolBlockEl) {
  if (!block) return;
  block.removeAttribute("id");
  toolCapabilityScope?.setTimeout(() => {
    block.setAttribute("data-collapsed", "true");
  }, 1500);
}

function appendToolBlockToMessage(message: Element, block: HTMLElement) {
  getAssistantResponseHost(message).appendChild(block);
}

function placeToolBlock(
  block: HTMLElement,
  canPlace: () => boolean = () => true,
  onPlaced?: (message: Element) => void,
) {
  const tryPlace = () => {
    if (!canPlace()) return false;
    // Find last assistant message container
    const messages = getAssistantMessages();
    if (messages.length === 0) return false;

    const lastMsg = messages[messages.length - 1];
    appendToolBlockToMessage(lastMsg, block);
    onPlaced?.(lastMsg);
    return true;
  };

  if (!tryPlace()) {
    // DOM not ready yet — retry after a short delay
    const scope = toolCapabilityScope;
    if (!scope?.active) return;
    const timer = scope.setInterval(() => {
      if (tryPlace()) scope.clearInterval(timer);
    }, 200);
    scope.setTimeout(() => scope.clearInterval(timer), 5000);
  }
}

// --- Background image feature (unchanged) ---

function getToolbarBottom(): number {
  const root = document.getElementById("root");
  if (!root) return 0;

  function walk(el: Element): number {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.top >= -2 &&
      rect.top <= 5 &&
      rect.height > 30 &&
      rect.height <= 80 &&
      rect.width > 300 &&
      (style.position === "absolute" ||
        style.position === "sticky" ||
        style.position === "fixed")
    ) {
      return rect.bottom;
    }
    for (const child of el.children) {
      const result = walk(child);
      if (result > 0) return result;
    }
    return 0;
  }

  return walk(root);
}

function hasVisibleBackground(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  const bgImg = style.backgroundImage;
  return (
    (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") ||
    (bgImg !== "none" && bgImg !== "")
  );
}

function getPromptTextarea(): HTMLTextAreaElement | null {
  return findPromptTextarea(document);
}

function findDeepSeekInputBox(): HTMLElement | null {
  const textarea = getPromptTextarea();
  if (!textarea) return null;

  const root = document.getElementById("root");
  const textareaRect = textarea.getBoundingClientRect();
  let candidate: HTMLElement | null = null;
  let el: Element | null = textarea.parentElement;

  while (el && el !== root && el !== document.body) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (isTightPromptInputFrame(rect, textareaRect, style)) {
        return el;
      }

      if (
        !candidate &&
        isPromptInputFrameCandidate(rect, textareaRect, style)
      ) {
        candidate = el;
      }
    }
    el = el.parentElement;
  }

  return candidate ?? textarea.parentElement;
}

function isPromptInputFrameCandidate(
  rect: DOMRect,
  textareaRect: DOMRect,
  style: CSSStyleDeclaration,
): boolean {
  return (
    rect.width >= textareaRect.width &&
    rect.height >= textareaRect.height &&
    rect.height <= Math.max(260, textareaRect.height + 180) &&
    rect.width <=
      Math.max(textareaRect.width + 260, textareaRect.width * 1.25) &&
    (hasVisibleBackground(style) ||
      Number.parseFloat(style.borderRadius) > 0 ||
      Number.parseFloat(style.borderTopWidth) > 0 ||
      Number.parseFloat(style.borderBottomWidth) > 0)
  );
}

function isTightPromptInputFrame(
  rect: DOMRect,
  textareaRect: DOMRect,
  style: CSSStyleDeclaration,
): boolean {
  const borderRadius = Number.parseFloat(style.borderRadius);
  const hasBorder =
    Number.parseFloat(style.borderTopWidth) > 0 ||
    Number.parseFloat(style.borderBottomWidth) > 0;

  return (
    isPromptInputFrameCandidate(rect, textareaRect, style) &&
    borderRadius >= 12 &&
    (hasVisibleBackground(style) || hasBorder || style.overflow === "hidden")
  );
}

function patchContainerBackgrounds() {
  if (!document.body.classList.contains("dpp-bg-active")) return;
  const root = document.getElementById("root");
  if (!root) return;

  const textarea = getPromptTextarea();
  if (!textarea) return;

  const inputBox = findDeepSeekInputBox();
  if (!inputBox) return;

  let el = inputBox.parentElement;
  while (el && el !== root && el !== document.body) {
    const style = getComputedStyle(el);
    if (hasVisibleBackground(style)) {
      (el as HTMLElement).setAttribute("data-dpp-transparent", "");
    }

    if (style.position === "sticky") {
      for (const child of el.children) {
        if (child.contains(textarea)) continue;
        if (hasVisibleBackground(getComputedStyle(child))) {
          (child as HTMLElement).setAttribute("data-dpp-transparent", "");
        }
      }
    }

    el = el.parentElement;
  }
}

function removeBackground() {
  document.getElementById("dpp-bg")?.remove();
  document.getElementById("dpp-bg-style")?.remove();
  document.body.classList.remove("dpp-bg-active");
  document.body.style.removeProperty("--dpp-overlay-light");
  document.body.style.removeProperty("--dpp-overlay-dark");
  document.body.style.removeProperty("--dpp-blur");
  document
    .querySelectorAll("[data-dpp-transparent]")
    .forEach((element) => element.removeAttribute("data-dpp-transparent"));
}

function applyPetConfig(config: PetConfig | null) {
  const normalizedConfig = normalizePetConfig(config);
  currentPetConfig = normalizedConfig;

  if (!normalizedConfig.enabled) {
    removePet();
    return;
  }

  const host = ensurePet();
  host.style.setProperty("--dpp-pet-size", `${normalizedConfig.size}px`);
  host.style.opacity = normalizedConfig.opacity.toFixed(2);
  host.dataset.motion = String(normalizedConfig.motion);
  host.dataset.position = normalizedConfig.position;
  applyPetPosition(host, normalizedConfig);
}

function ensurePet(): HTMLElement {
  injectPetStyles();
  installPetResizeListener();

  if (petHostEl?.isConnected) return petHostEl;

  const host = document.createElement("div");
  host.id = PET_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.dataset.state = "idle";
  host.dataset.motion = "true";
  host.innerHTML = createPetMarkup();
  host.addEventListener("pointerdown", handlePetPointerDown);
  host.addEventListener("pointermove", handlePetPointerMove);
  host.addEventListener("pointerup", handlePetPointerUp);
  host.addEventListener("pointercancel", handlePetPointerCancel);
  host.addEventListener("pointerenter", handlePetPointerEnter);
  document.body.appendChild(host);
  petHostEl = host;
  petBubbleEl = host.querySelector<HTMLElement>(".dpp-pet-bubble");
  petBubbleTextEl = host.querySelector<HTMLElement>(".dpp-pet-bubble-text");
  return host;
}

function removePet() {
  clearPetIdleTimer();
  clearPetSleepTimer();
  hidePetBubble();
  petDragState = null;
  petBubbleState = null;
  petRecentLines.length = 0;
  petHostEl?.remove();
  petHostEl = null;
  petBubbleEl = null;
  petBubbleTextEl = null;
  uninstallPetResizeListener();
}

function setPetState(state: PetState) {
  if (!currentPetConfig?.enabled || !petHostEl?.isConnected) return;
  clearPetIdleTimer();
  clearPetSleepTimer();
  applyPetState(state);
}

// Single exit for state transitions: write dataset and speak only on actual changes.
// updatePetFromTokenSpeed calls setPetState frequently during streaming, so this
// change detection prevents repeated bubble resets.
function applyPetState(state: PetState) {
  if (!petHostEl?.isConnected) return;
  const previous = petHostEl.dataset.state as PetState | undefined;
  petHostEl.dataset.state = state;
  if (state !== previous) {
    triggerPetBubble(state);
  }
}

function schedulePetIdle(delay = PET_IDLE_DELAY_MS) {
  if (!currentPetConfig?.enabled || !petHostEl?.isConnected) return;
  clearPetIdleTimer();
  clearPetSleepTimer();
  petIdleTimer = setTimeout(() => {
    if (petHostEl?.isConnected) {
      applyPetState("idle");
      schedulePetSleep();
    }
    petIdleTimer = null;
  }, delay);
}

function schedulePetSleep() {
  if (!currentPetConfig?.enabled || !petHostEl?.isConnected) return;
  clearPetSleepTimer();
  petSleepTimer = setTimeout(() => {
    if (petHostEl?.isConnected && petHostEl.dataset.state === "idle") {
      applyPetState("sleepy");
    }
    petSleepTimer = null;
  }, PET_SLEEP_DELAY_MS);
}

function clearPetIdleTimer() {
  if (petIdleTimer) {
    clearTimeout(petIdleTimer);
    petIdleTimer = null;
  }
}

function clearPetSleepTimer() {
  if (petSleepTimer) {
    clearTimeout(petSleepTimer);
    petSleepTimer = null;
  }
}

// Speak once when entering a state; looping states schedule the next line.
function triggerPetBubble(state: PetState) {
  if (!currentPetConfig?.enabled || !petHostEl?.isConnected) return;
  if (petDragState) return; // Keep quiet while dragging.
  clearPetBubbleRepeatTimer();
  petBubbleState = state;
  showPetBubble(pickPetLine(state, petRecentLines, currentContentLocale));
  if (PET_BUBBLE_LOOPING_STATES.has(state)) {
    armPetBubbleRepeat();
  }
}

function armPetBubbleRepeat() {
  clearPetBubbleRepeatTimer();
  const span = PET_BUBBLE_REPEAT_MAX_MS - PET_BUBBLE_REPEAT_MIN_MS;
  const delay =
    PET_BUBBLE_REPEAT_MIN_MS + Math.floor(Math.random() * (span + 1));
  petBubbleRepeatTimer = setTimeout(() => {
    petBubbleRepeatTimer = null;
    const state = petBubbleState;
    if (!state || !petHostEl?.isConnected || petDragState) return;
    if (petHostEl.dataset.state !== state) return; // State changed; the new state owns the loop.
    showPetBubble(pickPetLine(state, petRecentLines, currentContentLocale));
    armPetBubbleRepeat();
  }, delay);
}

function showPetBubble(line: string) {
  if (!line || !petBubbleEl || !petBubbleTextEl) return;
  rememberPetLine(line);
  petBubbleTextEl.textContent = line;
  petBubbleEl.dataset.visible = "true";
  if (petBubbleHideTimer) clearTimeout(petBubbleHideTimer);
  petBubbleHideTimer = setTimeout(() => {
    petBubbleHideTimer = null;
    if (petBubbleEl) petBubbleEl.dataset.visible = "false";
  }, PET_BUBBLE_VISIBLE_MS);
}

// Hide the bubble immediately and stop rotation during drag, hover, or removal.
function hidePetBubble() {
  clearPetBubbleRepeatTimer();
  if (petBubbleHideTimer) {
    clearTimeout(petBubbleHideTimer);
    petBubbleHideTimer = null;
  }
  if (petBubbleEl) petBubbleEl.dataset.visible = "false";
}

function clearPetBubbleRepeatTimer() {
  if (petBubbleRepeatTimer) {
    clearTimeout(petBubbleRepeatTimer);
    petBubbleRepeatTimer = null;
  }
}

function rememberPetLine(line: string) {
  petRecentLines.push(line);
  while (petRecentLines.length > PET_BUBBLE_RECENT_LIMIT) {
    petRecentLines.shift();
  }
}

function updatePetFromTokenSpeed(progress: ResponseTokenSpeedPayload) {
  if (!currentPetConfig?.enabled) return;
  if (!progress.active) {
    schedulePetIdle();
    return;
  }
  setPetState(progress.textLength > 0 ? "speaking" : "thinking");
}

function applyPetPosition(host: HTMLElement, config: PetConfig) {
  Object.assign(host.style, getPetPositionStyle(config));
}

function getPetPositionStyle(config: PetConfig): Partial<CSSStyleDeclaration> {
  if (config.position === "custom" && config.customPosition) {
    return getPetCustomPositionStyle(config.customPosition, config.size);
  }

  const base: Partial<CSSStyleDeclaration> = {
    top: "auto",
    bottom: `${PET_BOTTOM_OFFSET_PX}px`,
  };
  if (config.position === "bottom-left") {
    return {
      ...base,
      left: `${PET_SIDE_OFFSET_PX}px`,
      right: "auto",
    };
  }
  return {
    ...base,
    right: `${PET_SIDE_OFFSET_PX}px`,
    left: "auto",
  };
}

function getPetCustomPositionStyle(
  position: PetCustomPosition,
  size: number,
): Partial<CSSStyleDeclaration> {
  const width = size;
  const height = size * PET_HEIGHT_RATIO;
  const left = clampPetPixelPosition(
    position.x * window.innerWidth - width / 2,
    window.innerWidth,
    width,
  );
  const top = clampPetPixelPosition(
    position.y * window.innerHeight - height / 2,
    window.innerHeight,
    height,
  );
  return {
    left: `${left}px`,
    top: `${top}px`,
    right: "auto",
    bottom: "auto",
  };
}

function clampPetPixelPosition(
  value: number,
  viewportSize: number,
  petSize: number,
): number {
  const max = Math.max(
    PET_CUSTOM_EDGE_MARGIN_PX,
    viewportSize - petSize - PET_CUSTOM_EDGE_MARGIN_PX,
  );
  return Math.min(max, Math.max(PET_CUSTOM_EDGE_MARGIN_PX, value));
}

function handlePetPointerDown(event: PointerEvent) {
  if (
    event.button !== 0 ||
    !currentPetConfig?.enabled ||
    !petHostEl?.isConnected
  )
    return;

  const rect = petHostEl.getBoundingClientRect();
  petDragState = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    moved: false,
  };
  petHostEl.dataset.dragging = "true";
  hidePetBubble();
  petHostEl.setPointerCapture(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
}

function handlePetPointerMove(event: PointerEvent) {
  if (
    !petDragState ||
    event.pointerId !== petDragState.pointerId ||
    !petHostEl?.isConnected
  )
    return;

  const rect = petHostEl.getBoundingClientRect();
  const deltaX = event.clientX - petDragState.startClientX;
  const deltaY = event.clientY - petDragState.startClientY;
  const left = clampPetPixelPosition(
    petDragState.startLeft + deltaX,
    window.innerWidth,
    rect.width,
  );
  const top = clampPetPixelPosition(
    petDragState.startTop + deltaY,
    window.innerHeight,
    rect.height,
  );

  petDragState.moved =
    petDragState.moved || Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3;
  petHostEl.style.left = `${left}px`;
  petHostEl.style.top = `${top}px`;
  petHostEl.style.right = "auto";
  petHostEl.style.bottom = "auto";
  event.preventDefault();
  event.stopPropagation();
}

function handlePetPointerUp(event: PointerEvent) {
  finishPetDrag(event);
}

function handlePetPointerCancel(event: PointerEvent) {
  finishPetDrag(event);
}

// Hide bubbles on hover to avoid blocking pet interactions.
function handlePetPointerEnter() {
  hidePetBubble();
}

function finishPetDrag(event: PointerEvent) {
  if (
    !petDragState ||
    event.pointerId !== petDragState.pointerId ||
    !petHostEl?.isConnected
  )
    return;

  const moved = petDragState.moved;
  petDragState = null;
  delete petHostEl.dataset.dragging;
  if (petHostEl.hasPointerCapture(event.pointerId)) {
    petHostEl.releasePointerCapture(event.pointerId);
  }

  if (moved && currentPetConfig) {
    const config = normalizePetConfig({
      ...currentPetConfig,
      position: "custom",
      customPosition: getPetCustomPosition(petHostEl),
    });
    currentPetConfig = config;
    void sendRuntimeMessage({ type: "SAVE_PET", payload: config });
  }

  // After dragging, reschedule the current looping state because hidePetBubble paused it.
  const state = petHostEl.dataset.state as PetState | undefined;
  if (state && PET_BUBBLE_LOOPING_STATES.has(state)) {
    petBubbleState = state;
    armPetBubbleRepeat();
  }

  event.preventDefault();
  event.stopPropagation();
}

function getPetCustomPosition(host: HTMLElement): PetCustomPosition {
  const rect = host.getBoundingClientRect();
  return {
    x: clampPetRatio(
      (rect.left + rect.width / 2) / Math.max(window.innerWidth, 1),
    ),
    y: clampPetRatio(
      (rect.top + rect.height / 2) / Math.max(window.innerHeight, 1),
    ),
  };
}

function clampPetRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function installPetResizeListener() {
  if (petResizeListenerInstalled) return;
  window.addEventListener("resize", handlePetViewportResize);
  petResizeListenerInstalled = true;
}

function uninstallPetResizeListener() {
  if (!petResizeListenerInstalled) return;
  window.removeEventListener("resize", handlePetViewportResize);
  petResizeListenerInstalled = false;
}

function handlePetViewportResize() {
  if (!currentPetConfig?.enabled || !petHostEl?.isConnected || petDragState)
    return;
  applyPetPosition(petHostEl, currentPetConfig);
}

function injectPetStyles() {
  if (document.getElementById(PET_STYLE_ID)) return;

  const style = document.createElement("style");
  const spriteUrl = escapeCssUrl(chrome.runtime.getURL(PET_SPRITE_PATH));
  style.id = PET_STYLE_ID;
  style.textContent = `
    #${PET_HOST_ID} {
      --dpp-pet-size: 132px;
      position: fixed;
      width: var(--dpp-pet-size);
      height: var(--dpp-pet-size);
      z-index: 2147483646;
      pointer-events: auto;
      cursor: grab;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      transform-origin: center bottom;
      filter: drop-shadow(0 14px 24px rgba(39, 78, 180, 0.20));
      transition: opacity 0.18s ease, transform 0.18s ease;
    }

    #${PET_HOST_ID}[data-dragging='true'] {
      cursor: grabbing;
    }

    #${PET_HOST_ID} .dpp-pet-motion,
    #${PET_HOST_ID} .dpp-pet-sprite {
      width: 100%;
      height: 100%;
    }

    #${PET_HOST_ID} .dpp-pet-motion {
      transform-origin: center bottom;
    }

    #${PET_HOST_ID} .dpp-pet-sprite {
      background-image: url("${spriteUrl}");
      background-repeat: no-repeat;
      background-size: 400% 200%;
      background-position: 0% 0%;
      transform-origin: center bottom;
      will-change: transform, background-position;
    }

    #${PET_HOST_ID}[data-state='thinking'] .dpp-pet-sprite {
      background-position: 33.333333% 0%;
    }

    #${PET_HOST_ID}[data-state='speaking'] .dpp-pet-sprite {
      background-position: 66.666667% 0%;
    }

    #${PET_HOST_ID}[data-state='working'] .dpp-pet-sprite {
      background-position: 100% 0%;
    }

    #${PET_HOST_ID}[data-state='confused'] .dpp-pet-sprite {
      background-position: 0% 100%;
    }

    #${PET_HOST_ID}[data-state='success'] .dpp-pet-sprite {
      background-position: 33.333333% 100%;
    }

    #${PET_HOST_ID}[data-state='error'] .dpp-pet-sprite {
      background-position: 66.666667% 100%;
    }

    #${PET_HOST_ID}[data-state='sleepy'] .dpp-pet-sprite {
      background-position: 100% 100%;
    }

    #${PET_HOST_ID}[data-motion='true'] .dpp-pet-motion {
      animation: dpp-pet-float 4.8s cubic-bezier(0.45, 0, 0.2, 1) infinite;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='thinking'] .dpp-pet-sprite {
      animation: dpp-pet-think 2.2s ease-in-out infinite;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='speaking'] .dpp-pet-sprite {
      animation: dpp-pet-speak 0.72s ease-in-out infinite;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='working'] .dpp-pet-sprite {
      animation: dpp-pet-work 1s ease-in-out infinite;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='confused'] .dpp-pet-sprite {
      animation: dpp-pet-confused 1.8s ease-in-out infinite;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='success'] .dpp-pet-sprite {
      animation: dpp-pet-success 1.1s ease-out 1;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='error'] .dpp-pet-sprite {
      animation: dpp-pet-error 0.42s ease-in-out 2;
    }

    #${PET_HOST_ID}[data-motion='true'][data-state='sleepy'] .dpp-pet-motion {
      animation-duration: 7s;
    }

    @keyframes dpp-pet-float {
      0%, 100% { transform: translateY(0) rotate(-1deg); }
      50% { transform: translateY(-7px) rotate(1deg); }
    }

    @keyframes dpp-pet-think {
      0%, 100% { transform: translateX(0) rotate(0deg); }
      50% { transform: translateX(-3px) rotate(-1.5deg); }
    }

    @keyframes dpp-pet-speak {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.035); }
    }

    @keyframes dpp-pet-work {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }

    @keyframes dpp-pet-confused {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      35% { transform: translateY(-4px) rotate(-3deg); }
      70% { transform: translateY(-2px) rotate(3deg); }
    }

    @keyframes dpp-pet-success {
      0% { transform: scale(0.96) translateY(2px); }
      55% { transform: scale(1.08) translateY(-6px); }
      100% { transform: scale(1) translateY(0); }
    }

    @keyframes dpp-pet-error {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }

    #${PET_HOST_ID} .dpp-pet-bubble {
      position: absolute;
      bottom: calc(100% - 24px);
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      z-index: 1;
      max-width: 200px;
    }

    #${PET_HOST_ID} .dpp-pet-bubble-text {
      display: inline-block;
      position: relative;
      max-width: 200px;
      box-sizing: border-box;
      padding: 5px 11px;
      border-radius: 13px;
      border: 1px solid rgba(64, 110, 240, 0.45);
      background: rgba(255, 255, 255, 0.94);
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 18px rgba(39, 78, 180, 0.18);
      color: #1d2433;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      letter-spacing: 0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0;
      transform: translateY(6px) scale(0.94);
      transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.3, 0.64, 1);
      will-change: opacity, transform;
    }

    #${PET_HOST_ID} .dpp-pet-bubble-text::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-top-color: rgba(255, 255, 255, 0.94);
      filter: drop-shadow(0 2px 1px rgba(39, 78, 180, 0.12));
    }

    #${PET_HOST_ID} .dpp-pet-bubble[data-visible='true'] .dpp-pet-bubble-text {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    #${PET_HOST_ID}[data-motion='true'] .dpp-pet-bubble[data-visible='true'] .dpp-pet-bubble-text {
      animation: dpp-pet-bubble-float 3.6s ease-in-out infinite;
    }

    @keyframes dpp-pet-bubble-float {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-2.5px) scale(1); }
    }

    @media (prefers-color-scheme: dark) {
      #${PET_HOST_ID} .dpp-pet-bubble-text {
        border-color: rgba(120, 156, 255, 0.5);
        background: rgba(32, 38, 56, 0.92);
        color: #eef2ff;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
      }

      #${PET_HOST_ID} .dpp-pet-bubble-text::after {
        border-top-color: rgba(32, 38, 56, 0.92);
        filter: none;
      }
    }

    @media (max-width: 720px) {
      #${PET_HOST_ID}:not([data-position='custom']) {
        bottom: 76px !important;
        transform: scale(0.86);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${PET_HOST_ID} *,
      #${PET_HOST_ID} .dpp-pet-motion,
      #${PET_HOST_ID} .dpp-pet-sprite {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function createPetMarkup(): string {
  return `
    <div class="dpp-pet-bubble" data-visible="false">
      <span class="dpp-pet-bubble-text"></span>
    </div>
    <div class="dpp-pet-motion">
      <div class="dpp-pet-sprite"></div>
    </div>
  `;
}

function escapeCssUrl(url: string): string {
  return url
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\)/g, "\\)")
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ");
}

function applyBackground(config: BackgroundConfig | null) {
  const normalizedConfig = normalizeBackgroundConfig(config);
  if (!normalizedConfig?.enabled) {
    removeBackground();
    return;
  }

  const imageUrl =
    (normalizedConfig.type === "url"
      ? normalizedConfig.url
      : normalizedConfig.imageData) || null;

  if (!imageUrl) {
    removeBackground();
    return;
  }

  const existingBg = document.getElementById("dpp-bg");
  const existingStyle = document.getElementById("dpp-bg-style");

  document.body.classList.add("dpp-bg-active");

  const overlayAlpha = (1 - normalizedConfig.opacity).toFixed(3);
  const blurPx = ((1 - normalizedConfig.opacity) * 8).toFixed(1);
  document.body.style.setProperty(
    "--dpp-overlay-light",
    `rgba(255, 255, 255, ${overlayAlpha})`,
  );
  document.body.style.setProperty(
    "--dpp-overlay-dark",
    `rgba(30, 30, 30, ${overlayAlpha})`,
  );
  document.body.style.setProperty("--dpp-blur", `blur(${blurPx}px)`);

  const topOffset = getToolbarBottom();

  const bgDiv = existingBg || document.createElement("div");
  bgDiv.id = "dpp-bg";
  Object.assign(bgDiv.style, {
    position: "fixed",
    top: `${topOffset}px`,
    left: "0",
    right: "0",
    bottom: "0",
    zIndex: "-1",
    backgroundImage: `url("${escapeCssUrl(imageUrl)}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    pointerEvents: "none",
  });
  if (!existingBg) document.body.prepend(bgDiv);

  const styleEl = existingStyle || document.createElement("style");
  styleEl.id = "dpp-bg-style";
  styleEl.textContent = `
    #dpp-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--dpp-overlay-light);
      backdrop-filter: var(--dpp-blur);
      -webkit-backdrop-filter: var(--dpp-blur);
      pointer-events: none;
    }

    body.dpp-bg-active,
    body.dpp-bg-active #root,
    body.dpp-bg-active #__next {
      background: transparent !important;
    }

    body.dpp-bg-active #root > div,
    body.dpp-bg-active #__next > div {
      background: transparent !important;
    }

    body.dpp-bg-active #root > div > div,
    body.dpp-bg-active #__next > div > div {
      background: transparent !important;
    }

    body.dpp-bg-active [data-dpp-transparent] {
      background: transparent !important;
    }

    body.dpp-theme-dark #dpp-bg::after {
      background: var(--dpp-overlay-dark);
    }

    @media (prefers-color-scheme: dark) {
      body:not(.dpp-theme-light) #dpp-bg::after {
        background: var(--dpp-overlay-dark);
      }
    }
  `;
  if (!existingStyle) document.head.appendChild(styleEl);

  patchContainerBackgrounds();
}

/**
 * 监听当前浏览器的发送事件，记录发送的消息内容
 * 用于自适应检测：如果新消息是当前浏览器刚发的，就跳过不重发
 */
function setupLocalSendListener(): () => void {
  // 读取当前活动输入框内容（textarea 或 contenteditable），用于判定是否真的在发送。
  const readActiveInput = (): string => {
    const ta = getPromptTextarea();
    if (ta && ta.value.trim()) return ta.value;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      return active.textContent ?? "";
    }
    return "";
  };

  // P0-1：发送入口最前先消费待刷新的原生历史标记，命中则先刷新再返回，
  // 避免在已完成任务的陈旧页面上继续提交导致链分叉。
  const consumePendingReload = (): boolean => {
    if (!hasPendingNativeReload(sessionStorage)) return false;
    return consumeNativeHistoryReload({
      storage: sessionStorage,
      isHidden: () => document.hidden,
      reload: () => window.location.reload(),
    });
  };

  // 监听 textarea 的 keydown 事件（Enter 键发送）
  const onKeyDown = (e: KeyboardEvent) => {
    if (consumePendingReload()) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        const content = target.tagName === 'TEXTAREA'
          ? (target as HTMLTextAreaElement).value
          : target.textContent || '';
        if (content && content.trim()) {
          recordLocalSentMessage(content.trim());
        }
      }
    }
  };

  // 也监听点击发送按钮的情况
  const onClick = (e: MouseEvent) => {
    if (consumePendingReload()) return;
    const target = e.target as HTMLElement;
    if (target && target.closest('button')) {
      recordLocalSendFromActiveInput();
    }
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onClick, true);
  };
}
