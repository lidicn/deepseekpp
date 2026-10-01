import { SHELL_TOOL_NAMES } from '../shell/contracts';
import type { Memory, ToolDescriptor } from '../types';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createDefaultToolDescriptors,
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
  getToolInvocationNames,
  type ToolInvocationCatalog,
} from '../tool';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from '../memory/selector';
import { markVisibleUserPrompt, markVisibleUserPromptMetadata } from './visibility';
import {
  createToolBlockParts,
  measureCatalogParts,
  renderCatalogParts,
  renderCatalogSharedRegion,
} from './catalog-template';
import { refactorTelemetry } from '../debug/refactor-telemetry';

export interface PromptAugmentationOptions {
  memories?: readonly Memory[];
  thinkingEnabled?: boolean;
  identityOnly?: boolean;
  visibleUserPrompt?: string;
  // System context for local indexed skills ("activation instruction + index"): injected into the
  // system-instruction region (like the ## Tools section), fixing the issue where implicit matches were
  // treated as visible user input (passive chit-chat) and ignored the disk-read instruction (Bug ②).
  skillSystemContext?: string | null;
  presetContent?: string | null;
  projectContext?: string | null;
  toolDescriptors?: readonly ToolDescriptor[];
  locale?: SupportedLocale;
  memoryEnabled?: boolean;
  systemPromptEnabled?: boolean;
  forceResponseLanguage?: SupportedLocale | null;
  /** L1 summary for hidden MCP tools, rendered at the end of the tool catalog block. */
  hiddenSummary?: string;
}

export interface PromptAugmentationResult {
  augmented: string;
  usedMemoryIds: number[];
  renderedToolCount: number;
}

export function buildPromptAugmentation(
  originalPrompt: string,
  options?: PromptAugmentationOptions,
): PromptAugmentationResult {
  const {
    memories = [],
    thinkingEnabled = false,
    identityOnly = false,
    skillSystemContext = null,
    presetContent = null,
    projectContext = null,
    locale = DEFAULT_LOCALE,
    memoryEnabled = true,
    systemPromptEnabled = true,
    forceResponseLanguage = null,
    hiddenSummary = '',
  } = options ?? {};
  const toolDescriptors = options?.toolDescriptors ?? createDefaultToolDescriptors(locale);
  const visiblePromptMetadata = options?.visibleUserPrompt === undefined
    ? ''
    : `${markVisibleUserPromptMetadata(options.visibleUserPrompt)}\n`;

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);
  const selected = memoryEnabled
    ? selectMemories(originalPrompt, [...memories], { budget, identityOnly })
    : [];
  const memBlock = memoryEnabled
    ? formatMemoriesBlock(selected, locale)
    : translate(locale, 'prompt.memoryDisabled');
  const toolsBlock = systemPromptEnabled ? renderToolSchemas(toolDescriptors, locale, hiddenSummary) : '';
  const baseSystem = systemPromptEnabled
    ? translate(
      locale,
      thinkingEnabled ? 'prompt.systemThinking' : 'prompt.systemChat',
      { memories: memBlock, tools: toolsBlock },
    )
    : '';
  const standaloneMemories = !systemPromptEnabled && memoryEnabled
    ? translate(locale, 'prompt.standaloneMemories', { memories: memBlock })
    : '';
  const system = [
    baseSystem,
    skillSystemContext ? renderSkillSystemContext(skillSystemContext, locale) : '',
    standaloneMemories,
    renderProjectContext(projectContext),
    systemPromptEnabled ? renderWebSearchGuidance(toolDescriptors, locale) : '',
    renderForcedResponseLanguage(forceResponseLanguage, locale),
  ].filter(Boolean).join('\n\n');
  const presetPrefix = presetContent ? `${presetContent}\n\n---\n\n` : '';
  const toolReminder = systemPromptEnabled ? renderToolFormatReminder(toolDescriptors, locale) : '';
  const systemPrefix = system ? `${system}\n\n` : '';

  return {
    augmented: presetPrefix + systemPrefix + visiblePromptMetadata + markVisibleUserPrompt(originalPrompt) + toolReminder,
    usedMemoryIds: selected.map((memory) => memory.id!).filter(Boolean),
    renderedToolCount: systemPromptEnabled ? toolDescriptors.length : 0,
  };
}

function renderProjectContext(projectContext?: string | null): string {
  const trimmed = typeof projectContext === 'string' ? projectContext.trim() : '';
  return trimmed;
}

function renderForcedResponseLanguage(
  forceResponseLanguage: SupportedLocale | null,
  locale: SupportedLocale,
): string {
  if (!forceResponseLanguage) return '';
  const language = forceResponseLanguage === 'en'
    ? translate(locale, 'prompt.responseLanguageEnglish')
    : translate(locale, 'prompt.responseLanguageChinese');
  return translate(locale, 'prompt.forceResponseLanguage', { language });
}

function renderSkillSystemContext(context: string, locale: SupportedLocale): string {
  const header = translate(locale, 'prompt.localSkillSystemContextHeader');
  return `${header}\n\n${context}`;
}

// v1.17 性能优化：工具目录渲染 memo（会话内 descriptors 引用不变则复用）
const toolSchemaCache = new WeakMap<readonly ToolDescriptor[], {
  locale: SupportedLocale;
  hiddenSummary: string;
  rendered: string;
}>();

export function renderToolSchemas(
  descriptors?: readonly ToolDescriptor[],
  locale: SupportedLocale = DEFAULT_LOCALE,
  hiddenSummary = '',
): string {
  const resolvedDescriptors = descriptors ?? createDefaultToolDescriptors(locale);
  
  // 命中缓存：descriptors 引用不变 + locale/hiddenSummary 相同 → 直接复用
  const cached = toolSchemaCache.get(resolvedDescriptors);
  if (cached && cached.locale === locale && cached.hiddenSummary === hiddenSummary) {
    refactorTelemetry.recordToolSchemaCache(true);
    return cached.rendered;
  }
  refactorTelemetry.recordToolSchemaCache(false);
  // Prefix stability: sort by provider tier (builtin first) + name so the rendered
  // tool catalog is byte-identical regardless of input/discovery order.
  const sortedDescriptors = [...resolvedDescriptors].sort((a, b) => {
    const tierA = a.provider.kind === 'local' ? 0 : 1;
    const tierB = b.provider.kind === 'local' ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    return a.name.localeCompare(b.name);
  });
  const catalog = createToolInvocationCatalog(sortedDescriptors);
  const shellHint = renderShellMcpHint(sortedDescriptors, catalog, locale);
  const pythonHint = renderPythonMcpHint(sortedDescriptors, catalog, locale);
  const sharedRegion = renderCatalogSharedRegion(locale);
  const schemas = sortedDescriptors
    .map((descriptor) => renderToolSchema(descriptor, catalog))
    .join('\n\n');
  const rendered = [shellHint, pythonHint, sharedRegion, schemas, hiddenSummary]
    .filter(Boolean)
    .join('\n\n');
  
  // 存入缓存
  toolSchemaCache.set(resolvedDescriptors, { locale, hiddenSummary, rendered });
  
  return rendered;
}

function renderWebSearchGuidance(
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  const hasWebSearch = descriptors.some((descriptor) => descriptor.name === 'web_search');
  if (!hasWebSearch) return '';

  return translate(locale, 'prompt.webSearchGuidance');
}

function renderPythonMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
  locale: SupportedLocale,
): string {
  const pythonExec = descriptors.find((descriptor) => descriptor.name === 'python_exec');
  const pythonStatus = descriptors.find((descriptor) => descriptor.name === 'python_status');
  if (!pythonExec && !pythonStatus) return '';

  const execName = pythonExec ? getPreferredToolInvocationName(pythonExec, catalog) : null;
  const statusName = pythonStatus ? getPreferredToolInvocationName(pythonStatus, catalog) : null;

  return [
    translate(locale, 'prompt.pythonHintTitle'),
    execName
      ? translate(locale, 'prompt.pythonHintExec', { execName })
      : '',
    statusName
      ? translate(locale, 'prompt.pythonHintStatus', { statusName })
      : '',
    translate(locale, 'prompt.pythonHintAvailability'),
    translate(locale, 'prompt.pythonHintSafety'),
  ].filter(Boolean).join('\n');
}

function renderToolSchema(descriptor: ToolDescriptor, catalog: ToolInvocationCatalog): string {
  return renderCatalogParts(createToolBlockParts({
    preferredName: getPreferredToolInvocationName(descriptor, catalog),
    acceptedNames: getToolInvocationNames(descriptor, catalog),
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  }));
}

/**
 * Byte-truth used by the capability budget (R1-a): the estimator measures the
 * exact block the renderer will emit, from the same template definition.
 */
export function measureToolSchemaBytes(descriptor: ToolDescriptor): number {
  return measureCatalogParts(createToolBlockParts({
    preferredName: getPreferredToolInvocationName(descriptor, createToolInvocationCatalog([descriptor])),
    acceptedNames: getToolInvocationNames(descriptor, createToolInvocationCatalog([descriptor])),
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  }));
}

function renderShellMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
  locale: SupportedLocale,
): string {
  const shellExec = descriptors.find((descriptor) => descriptor.name === 'shell_exec');
  if (!shellExec) return '';

  const shellStatus = descriptors.find((descriptor) => descriptor.name === 'shell_status');
  const execName = getPreferredToolInvocationName(shellExec, catalog);
  const statusName = shellStatus ? getPreferredToolInvocationName(shellStatus, catalog) : null;

  return [
    translate(locale, 'prompt.shellHintTitle'),
    translate(locale, 'prompt.shellHintConnected'),
    translate(locale, 'prompt.shellHintExec', { execName }),
    statusName
      ? translate(locale, 'prompt.shellHintStatus', { statusName })
      : '',
    translate(locale, 'prompt.shellHintWindows'),
    translate(locale, 'prompt.shellHintSession'),
    translate(locale, 'prompt.shellHintNames', { names: SHELL_TOOL_NAMES.join(', ') }),
  ].filter(Boolean).join('\n');
}

export function renderToolFormatReminder(
  descriptors?: readonly ToolDescriptor[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const catalog = createToolInvocationCatalog(descriptors ?? createDefaultToolDescriptors(locale));
  const names = catalog.invocationNames;
  if (names.length === 0) return '';
  return `\n\n${translate(locale, 'prompt.toolFormatReminder', { names: names.join(', ') })}`;
}
