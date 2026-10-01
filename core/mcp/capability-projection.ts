import type { ToolDescriptor } from '../tool/types';
import { measureToolSchemaBytes, renderToolSchemas } from '../prompt/augmentation';
import type { SupportedLocale } from '../i18n/background';
import { utf8ByteLength } from '../prompt/catalog-template';
import {
  getMcpCapabilityServerSettings,
} from './capability-settings';
import type {
  McpCapabilityProjection,
  McpCapabilitySettings,
} from './capability-types';
import {
  getMcpCapabilityOperation,
  isMcpCapabilityDescriptor,
  MCP_CAPABILITY_OPERATIONS,
  type McpCapabilityOperation,
} from './capability-contract';
import { renderMcpHiddenToolSummary } from './capability-summary';

export interface McpCapabilityProjectionInput {
  descriptors: readonly ToolDescriptor[];
  settings: McpCapabilitySettings;
  intent: string;
  /** Prompt locale for byte measurement; defaults to 'en'. */
  locale?: string;
}

/**
 * Produces the model-facing MCP projection. It never creates, alters or
 * re-authorizes a real descriptor; execution always resolves against the full
 * current runtime descriptor set later.
 */
export function projectMcpCapabilityDescriptors(
  input: McpCapabilityProjectionInput,
): McpCapabilityProjection {
  const helpers = input.descriptors.filter(isMcpCapabilityDescriptor);
  const eligibleMcp = input.descriptors.filter(isExecutableMcpDescriptor);
  const serverModes = new Map(eligibleMcp.map((descriptor) => [
    descriptor.id,
    getMcpCapabilityServerSettings(input.settings, descriptor.provider.id),
  ]));
  const adaptive = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'adaptive');
  const onDemand = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'on_demand');
  const direct = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'direct');
  const pinned = new Set(
    adaptive.flatMap((descriptor) => serverModes.get(descriptor.id)?.pinnedDescriptorIds ?? []),
  );
  const locale = input.locale ?? 'en';
  const budget = createProjectionByteMeter(locale, helpers, direct, onDemand, adaptive);
  const selectedAdaptive = selectAdaptiveDescriptors(
    adaptive,
    input.intent,
    pinned,
    input.settings.adaptiveMaxDirectTools,
    input.settings.adaptiveMaxPromptBytes,
    budget,
  );
  const selectedIds = new Set([...direct, ...selectedAdaptive].map((descriptor) => descriptor.id));
  const hidden = [...onDemand, ...adaptive.filter((descriptor) => !selectedIds.has(descriptor.id))];

  if (hidden.length === 0) {
    // Default settings are direct. Preserve the released descriptor order and
    // exclude the internal catalog controls so legacy prompt bytes stay stable.
    return {
      descriptors: input.descriptors.filter((descriptor) => !isMcpCapabilityDescriptor(descriptor)),
      directDescriptorIds: eligibleMcp.map((descriptor) => descriptor.id),
      hiddenDescriptorIds: [],
      hiddenSummary: '',
      hiddenSummaryBytes: 0,
      projectedPromptBytes: budget.bytesForSelection([]),
      usesCatalog: false,
    };
  }

  assertCompleteCapabilityHelperSet(helpers);
  const descriptors = [
    ...input.descriptors.filter((descriptor) => (
      !isMcpCapabilityDescriptor(descriptor) &&
      (!isMcpDescriptor(descriptor) || !isExecutableMcpDescriptor(descriptor) || selectedIds.has(descriptor.id))
    )),
    ...helpers,
  ];
  const hiddenSummary = renderMcpHiddenToolSummary(hidden, {
    describeToolName: capabilityHelperInvocationName(helpers, 'describe'),
    invokeToolName: capabilityHelperInvocationName(helpers, 'invoke'),
    locale,
  });
  return {
    descriptors,
    directDescriptorIds: [...selectedIds],
    hiddenDescriptorIds: hidden.map((descriptor) => descriptor.id),
    hiddenSummary,
    hiddenSummaryBytes: utf8ByteLength(hiddenSummary),
    projectedPromptBytes: budget.bytesForSelection(selectedAdaptive),
    usesCatalog: true,
  };
}

export function rankMcpCapabilityDescriptors(
  descriptors: readonly ToolDescriptor[],
  query: string,
  pinnedDescriptorIds: ReadonlySet<string> = new Set(),
): ToolDescriptor[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = tokenize(normalizedQuery);
  return descriptors
    .map((descriptor, index) => ({
      descriptor,
      index,
      score: scoreDescriptor(descriptor, normalizedQuery, queryTerms, pinnedDescriptorIds.has(descriptor.id)),
    }))
    .sort((left, right) => (
      right.score - left.score ||
      compareLexical(
        normalizeSearchText(left.descriptor.title),
        normalizeSearchText(right.descriptor.title),
      ) ||
      compareLexical(
        normalizeSearchText(left.descriptor.name),
        normalizeSearchText(right.descriptor.name),
      ) ||
      left.index - right.index
    ))
    .map((entry) => entry.descriptor);
}

/**
 * Byte truth for one descriptor's catalog block (R1-a). This is the exact
 * block core/prompt/augmentation.ts renders, measured from the same template
 * definition, so `est/act === 1.00` by construction and any future template
 * drift breaks the budget tests instead of silently re-inflating the budget.
 */
export function estimateMcpCapabilityPromptBytes(descriptor: ToolDescriptor): number {
  return measureToolSchemaBytes(descriptor);
}

export function isMcpDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.provider.kind === 'mcp';
}

export function isExecutableMcpDescriptor(descriptor: ToolDescriptor): boolean {
  return isMcpDescriptor(descriptor) && descriptor.execution.enabled && descriptor.execution.mode !== 'disabled';
}

function selectAdaptiveDescriptors(
  descriptors: readonly ToolDescriptor[],
  intent: string,
  pinnedDescriptorIds: ReadonlySet<string>,
  maxTools: number,
  maxBytes: number,
  budget: ProjectionByteMeter,
): ToolDescriptor[] {
  const selected: ToolDescriptor[] = [];
  for (const descriptor of rankMcpCapabilityDescriptors(descriptors, intent, pinnedDescriptorIds)) {
    if (selected.length >= maxTools) continue;
    const trial = [...selected, descriptor];
    // Real rendered bytes of the whole MCP projection region (blocks + induced
    // shared hint heads + catalog helpers + L1 summary), minus the direct-only
    // baseline. Big tools are skipped, smaller ones still get their chance.
    if (budget.bytesForSelection(trial) > maxBytes) continue;
    selected.push(descriptor);
  }
  return selected;
}

function scoreDescriptor(
  descriptor: ToolDescriptor,
  normalizedQuery: string,
  queryTerms: readonly string[],
  pinned: boolean,
): number {
  const name = normalizeSearchText(`${descriptor.name} ${descriptor.invocationName}`);
  const title = normalizeSearchText(descriptor.title);
  const description = normalizeSearchText(descriptor.description);
  let score = pinned ? 10_000 : 0;
  if (normalizedQuery) {
    if (name.includes(normalizedQuery)) score += 1_000;
    if (title.includes(normalizedQuery)) score += 700;
    if (description.includes(normalizedQuery)) score += 250;
  }
  for (const term of queryTerms) {
    if (name.includes(term)) score += 120;
    if (title.includes(term)) score += 80;
    if (description.includes(term)) score += 25;
  }
  return score;
}

function assertCompleteCapabilityHelperSet(helpers: readonly ToolDescriptor[]): void {
  const operations = new Set(
    helpers.map(getMcpCapabilityOperation).filter((value): value is McpCapabilityOperation => value !== null),
  );
  const missing = MCP_CAPABILITY_OPERATIONS.filter((operation) => !operations.has(operation));
  if (missing.length === 0) return;
  throw new Error(`MCP capability catalog is incomplete: missing ${missing.join(', ')}.`);
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function compareLexical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function tokenize(value: string): string[] {
  const matches = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(matches.filter((term) => term.length >= 2))];
}

// ---------------------------------------------------------------------------
// Projection byte meter (R1-b / R1-c): measures the exact rendered bytes of
// any adaptive selection, including induced shared hint heads, catalog
// helpers, and the L1 hidden-tool summary. Cached by descriptor identity.
// ---------------------------------------------------------------------------

interface ProjectionByteMeter {
  /** Marginal prompt bytes of this adaptive selection (R4-b: L1 included). */
  bytesForSelection(trial: readonly ToolDescriptor[]): number;
}

const PROJECTION_BYTE_CACHE_LIMIT = 64;
const projectionByteCache = new Map<string, number>();
const descriptorTokens = new WeakMap<ToolDescriptor, string>();
let nextDescriptorToken = 0;

/**
 * Cache key material is descriptor *object identity* + locale + the selected
 * sequence. Invalidation conditions: descriptor objects are rebuilt by
 * normalizeMcpToolDescriptor whenever MCP tool data changes, locale changes
 * the key, and FIFO eviction bounds memory. Descriptors are used as immutable
 * values; if in-place mutation ever appears, this key must become a content
 * signature.
 */
function descriptorToken(descriptor: ToolDescriptor): string {
  const existing = descriptorTokens.get(descriptor);
  if (existing !== undefined) return existing;
  nextDescriptorToken += 1;
  const token = `d${nextDescriptorToken}`;
  descriptorTokens.set(descriptor, token);
  return token;
}

export function resetMcpCapabilityByteCache(): void {
  projectionByteCache.clear();
}

function createProjectionByteMeter(
  locale: string,
  helpers: readonly ToolDescriptor[],
  direct: readonly ToolDescriptor[],
  onDemand: readonly ToolDescriptor[],
  adaptive: readonly ToolDescriptor[],
): ProjectionByteMeter {
  const describeToolName = capabilityHelperInvocationName(helpers, 'describe');
  const invokeToolName = capabilityHelperInvocationName(helpers, 'invoke');
  const baselineBytes = utf8ByteLength(renderToolSchemas([...direct], locale as SupportedLocale));
  const directTokens = direct.map(descriptorToken);
  const helperTokens = helpers.map(descriptorToken);

  return {
    bytesForSelection(trial: readonly ToolDescriptor[]): number {
      const selectedIds = new Set([...direct, ...trial].map((descriptor) => descriptor.id));
      const key = [
        locale,
        directTokens.join(','),
        helperTokens.join(','),
        trial.map(descriptorToken).join(','),
      ].join('|');
      const cached = projectionByteCache.get(key);
      if (cached !== undefined) return cached;

      const value = computeSelectionBytes(
        trial,
        locale,
        helpers,
        direct,
        onDemand,
        adaptive,
        selectedIds,
        describeToolName,
        invokeToolName,
        baselineBytes,
      );
      if (projectionByteCache.size >= PROJECTION_BYTE_CACHE_LIMIT) {
        const oldest = projectionByteCache.keys().next();
        if (!oldest.done) projectionByteCache.delete(oldest.value);
      }
      projectionByteCache.set(key, value);
      return value;
    },
  };
}

function computeSelectionBytes(
  trial: readonly ToolDescriptor[],
  locale: string,
  helpers: readonly ToolDescriptor[],
  direct: readonly ToolDescriptor[],
  onDemand: readonly ToolDescriptor[],
  adaptive: readonly ToolDescriptor[],
  selectedIds: ReadonlySet<string>,
  describeToolName: string,
  invokeToolName: string,
  baselineBytes: number,
): number {
  // Hidden = onDemand + adaptive not selected (same formula as projectMcpCapabilityDescriptors line 55)
  const hidden = [...onDemand, ...adaptive.filter((d) => !selectedIds.has(d.id))];
  const summary = renderMcpHiddenToolSummary(hidden, {
    describeToolName,
    invokeToolName,
    locale,
  });
  const catalogDescriptors = hidden.length === 0
    ? [...direct, ...trial]
    : [...direct, ...trial, ...helpers];
  return utf8ByteLength(renderToolSchemas(catalogDescriptors, locale as SupportedLocale))
    + utf8ByteLength(summary)
    - baselineBytes;
}

function capabilityHelperInvocationName(
  helpers: readonly ToolDescriptor[],
  operation: McpCapabilityOperation,
): string {
  const helper = helpers.find((descriptor) => getMcpCapabilityOperation(descriptor) === operation);
  return helper ? (helper.invocationName || helper.name) : `mcp_${operation}`;
}
