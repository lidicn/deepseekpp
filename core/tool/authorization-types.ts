/**
 * authorization-types.ts — 工具授权类型与常量。
 * 职责：存储键、TTL、授权输入/执行类型、错误类、全局序列化锁。
 */
import type {
  RuntimeToolAuthorizationContext,
  ToolAuthorizationDescriptorSnapshot,
  ToolAuthorizationGrantSummary,
  ToolAuthorizationSubject,
  ToolCall,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
} from './types';
import {
  TOOL_EXECUTION_MODES,
  TOOL_EXECUTION_TRIGGERS,
  TOOL_PROVIDER_KINDS,
  TOOL_RISK_LEVELS,
  TOOL_TRANSPORT_KINDS,
} from './types';
import { isRetryableWebFetchPermissionPrecondition } from './web-fetch-permission';

export const TOOL_AUTHORIZATION_STORAGE_KEY = 'deepseek_pp_tool_authorizations';
export const TOOL_AUTHORIZATION_STATE_VERSION = 1 as const;
export const TOOL_AUTHORIZATION_TTL_MS = 30 * 60_000;
export const MAX_ACTIVE_GRANTS = 32;
export const MAX_CALLS_PER_GRANT = 128;
export const MAX_AUTHORIZATION_STATE_BYTES = 4 * 1024 * 1024;

export type StoredCallState = 'collecting' | 'executing' | 'consumed' | 'retryable';

export interface StoredCallAuthorization {
  descriptorId: string;
  state: StoredCallState;
  fingerprint?: string;
  retryUsed: boolean;
}

export interface StoredToolAuthorizationGrant {
  id: string;
  requestId: string;
  trigger: ToolExecutionTrigger;
  chatSessionId: string | null;
  taskId?: string;
  runId?: string;
  automationId?: string;
  automationRunId?: string;
  subject: ToolAuthorizationSubject;
  descriptors: ToolAuthorizationDescriptorSnapshot[];
  calls: Record<string, StoredCallAuthorization>;
  issuedAt: number;
  expiresAt: number;
  // Local-skill directory validated and written by background when creating the
  // grant. At execution time cwd is derived solely from this; any page/model-
  // supplied localSkillDir is ignored (Review #2).
  localSkillDir?: string;
}

export interface ToolAuthorizationState {
  version: typeof TOOL_AUTHORIZATION_STATE_VERSION;
  grants: Record<string, StoredToolAuthorizationGrant>;
}

export interface CreateToolAuthorizationInput {
  requestId: string;
  trigger: ToolExecutionTrigger;
  /**
   * An untrusted page/model routing claim. It never establishes a grant's
   * browser-owned chat-session binding.
   */
  chatSessionId?: string | null;
  taskId?: string;
  runId?: string;
  automationId?: string;
  automationRunId?: string;
  subject: ToolAuthorizationSubject;
  descriptors: readonly ToolDescriptor[];
  /**
   * Background-validated local-skill directory (from the augment's
   * activeLocalSkillDir). When non-empty, execution-time cwd is derived solely
   * from this; any page/model-supplied localSkillDir is ignored (Review #2).
   */
  localSkillDir?: string;
  now?: number;
}

export interface AuthorizedToolExecution {
  call: ToolCall;
  descriptor: ToolDescriptor;
  trigger: ToolExecutionTrigger;
  reservation: {
    grantId: string;
    callId: string;
  } | null;
  externalPayloadNamespace?: string;
}

export class ToolAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolAuthorizationError';
  }
}

export let authorizationMutation = Promise.resolve();


export function providerMatches(
  left: { kind: string; id: string; transport: string },
  right: { kind: string; id: string; transport: string },
): boolean {
  return left.kind === right.kind && left.id === right.id && left.transport === right.transport;
}

export function isExecutableDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.execution.enabled && descriptor.execution.mode !== 'disabled';
}

export function assertUniqueDescriptorIds(descriptors: readonly ToolDescriptor[]): void {
  if (new Set(descriptors.map((descriptor) => descriptor.id)).size === descriptors.length) return;
  throw new ToolAuthorizationError(
    'tool_descriptor_duplicate',
    'Tool authorization descriptors must have unique identities.',
  );
}

export function assertSubjectMatches(
  grant: StoredToolAuthorizationGrant,
  current: ToolAuthorizationSubject,
): boolean {
  assertOwnerDocumentMatches(grant, current);
  const expectedChatSessionId = normalizeChatSessionId(grant.subject.chatSessionId);
  const currentChatSessionId = normalizeChatSessionId(current.chatSessionId);
  if (expectedChatSessionId === null) {
    if (currentChatSessionId === null) {
      throw new ToolAuthorizationError(
        'tool_session_mismatch',
        'Tool authorization has not been bound to a browser-owned chat session.',
      );
    }
    grant.subject.chatSessionId = currentChatSessionId;
    grant.chatSessionId = currentChatSessionId;
    return true;
  }
  if (currentChatSessionId !== expectedChatSessionId) {
    throw new ToolAuthorizationError(
      'tool_session_mismatch',
      'Tool authorization belongs to another chat session.',
    );
  }
  return false;
}

export function assertOwnerDocumentMatches(
  grant: StoredToolAuthorizationGrant,
  current: ToolAuthorizationSubject,
): void {
  const expected = grant.subject;
  if (
    current.surface !== expected.surface ||
    current.documentSessionId !== expected.documentSessionId ||
    current.tabId !== expected.tabId ||
    current.frameId !== expected.frameId
  ) {
    throw new ToolAuthorizationError(
      'tool_session_mismatch',
      'Tool authorization belongs to another extension document.',
    );
  }
}

export function assertSubjectMatchesWithoutBinding(
  grant: StoredToolAuthorizationGrant,
  current: ToolAuthorizationSubject,
): void {
  assertOwnerDocumentMatches(grant, current);
  const expectedChatSessionId = normalizeChatSessionId(grant.subject.chatSessionId);
  const currentChatSessionId = normalizeChatSessionId(current.chatSessionId);
  if (expectedChatSessionId === null) return;
  if (expectedChatSessionId !== null && currentChatSessionId !== expectedChatSessionId) {
    throw new ToolAuthorizationError(
      'tool_session_mismatch',
      'Tool authorization belongs to another chat session.',
    );
  }
}

export function cloneSubject(subject: ToolAuthorizationSubject): ToolAuthorizationSubject {
  return {
    surface: subject.surface,
    documentSessionId: requireIdentity(subject.documentSessionId, 'documentSessionId'),
    tabId: subject.tabId,
    frameId: subject.frameId,
    chatSessionId: normalizeChatSessionId(subject.chatSessionId),
  };
}

export function optionalIdentityMismatch(claimed: string | undefined, expected: string | undefined): boolean {
  return claimed !== expected;
}

export function normalizeChatSessionId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function requireIdentity(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolAuthorizationError('tool_identity_missing', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function requireGrant(
  state: ToolAuthorizationState,
  grantId: string,
  now: number,
): StoredToolAuthorizationGrant {
  const grant = state.grants[grantId];
  if (!grant) {
    throw new ToolAuthorizationError('tool_authorization_missing', 'Tool authorization is missing or closed.');
  }
  if (grant.expiresAt <= now) {
    delete state.grants[grantId];
    throw new ToolAuthorizationError('tool_authorization_stale', 'Tool authorization has expired.');
  }
  return grant;
}


// --- State mutation & validation infrastructure ---

export function pruneState(state: ToolAuthorizationState, now: number): boolean {
  let changed = false;
  for (const [id, grant] of Object.entries(state.grants)) {
    if (grant.expiresAt <= now) {
      delete state.grants[id];
      changed = true;
    }
  }
  return changed;
}

export interface StateMutation<T> {
  result: T;
  changed: boolean;
}

export async function mutateState<T>(
  operation: (state: ToolAuthorizationState) => StateMutation<T> | Promise<StateMutation<T>>,
): Promise<T> {
  const run = authorizationMutation.then(async () => {
    const state = await readState();
    const mutation = await operation(state);
    if (mutation.changed) {
      assertStateWithinByteBudget(state);
      await chrome.storage.session.set({ [TOOL_AUTHORIZATION_STORAGE_KEY]: state });
    }
    return mutation.result;
  });
  authorizationMutation = run.then(() => undefined, () => undefined);
  return run;
}

export async function readState(): Promise<ToolAuthorizationState> {
  const stored = await chrome.storage.session.get(TOOL_AUTHORIZATION_STORAGE_KEY) as Record<string, unknown>;
  const value = stored[TOOL_AUTHORIZATION_STORAGE_KEY];
  if (value === undefined) {
    return { version: TOOL_AUTHORIZATION_STATE_VERSION, grants: {} };
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_AUTHORIZATION_STATE_BYTES ||
    !isStoredAuthorizationState(value)
  ) {
    throw new Error('Stored tool authorization state is invalid.');
  }
  return structuredClone(value);
}

export function isStoredAuthorizationState(value: unknown): value is ToolAuthorizationState {
  if (!isPlainRecord(value)) return false;
  const state = value as Partial<ToolAuthorizationState>;
  return hasOnlyKeys(value, ['version', 'grants']) &&
    state.version === TOOL_AUTHORIZATION_STATE_VERSION &&
    isPlainRecord(state.grants) &&
    Object.keys(state.grants).length <= MAX_ACTIVE_GRANTS &&
    Object.entries(state.grants).every(([id, grant]) => isStoredGrant(id, grant));
}

export function isStoredGrant(id: string, value: unknown): value is StoredToolAuthorizationGrant {
  if (!isPlainRecord(value)) return false;
  const grant = value as Partial<StoredToolAuthorizationGrant>;
  return hasOnlyKeys(value, [
    'id',
    'requestId',
    'trigger',
    'chatSessionId',
    'taskId',
    'runId',
    'automationId',
    'automationRunId',
    'subject',
    'descriptors',
    'calls',
    'issuedAt',
    'expiresAt',
    'localSkillDir',
  ]) &&
    grant.id === id &&
    isIdentity(grant.id) &&
    isIdentity(grant.requestId) &&
    (TOOL_EXECUTION_TRIGGERS as readonly string[]).includes(String(grant.trigger)) &&
    (grant.chatSessionId === null || isIdentity(grant.chatSessionId)) &&
    optionalIdentity(grant.taskId) &&
    optionalIdentity(grant.runId) &&
    optionalIdentity(grant.automationId) &&
    optionalIdentity(grant.automationRunId) &&
    isStoredSubject(grant.subject) &&
    hasValidStoredGrantSessionBinding(grant.chatSessionId, grant.subject) &&
    Array.isArray(grant.descriptors) &&
    grant.descriptors.every(isToolAuthorizationDescriptorSnapshotRecord) &&
    hasUniqueStoredDescriptorIds(grant.descriptors) &&
    isPlainRecord(grant.calls) &&
    Object.keys(grant.calls).length <= MAX_CALLS_PER_GRANT &&
    hasValidStoredCalls(grant.calls, grant.descriptors) &&
    isFiniteNumber(grant.issuedAt) &&
    isFiniteNumber(grant.expiresAt) &&
    grant.expiresAt > grant.issuedAt;
}

export function isStoredSubject(value: unknown): value is ToolAuthorizationSubject {
  if (!isPlainRecord(value)) return false;
  const subject = value as Partial<ToolAuthorizationSubject>;
  return hasOnlyKeys(value, ['surface', 'documentSessionId', 'tabId', 'frameId', 'chatSessionId']) &&
    (
    subject.surface === 'deepseek_content' ||
    subject.surface === 'extension_context' ||
    subject.surface === 'background_workflow'
  ) &&
    isIdentity(subject.documentSessionId) &&
    (subject.tabId === undefined || isNonNegativeInteger(subject.tabId)) &&
    (subject.frameId === undefined || isNonNegativeInteger(subject.frameId)) &&
    (subject.chatSessionId === null || isIdentity(subject.chatSessionId));
}

export function hasValidStoredGrantSessionBinding(
  grantChatSessionId: string | null | undefined,
  subject: ToolAuthorizationSubject,
): boolean {
  const subjectChatSessionId = normalizeChatSessionId(subject.chatSessionId);
  const normalizedGrantChatSessionId = normalizeChatSessionId(grantChatSessionId);
  return subjectChatSessionId === null ||
    normalizedGrantChatSessionId === null ||
    subjectChatSessionId === normalizedGrantChatSessionId;
}

export function hasUniqueStoredDescriptorIds(
  descriptors: readonly ToolAuthorizationDescriptorSnapshot[],
): boolean {
  return new Set(descriptors.map((descriptor) => descriptor.id)).size === descriptors.length;
}

export function hasValidStoredCalls(
  calls: Record<string, unknown>,
  descriptors: readonly ToolAuthorizationDescriptorSnapshot[],
): boolean {
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  return Object.entries(calls).every(([callId, call]) =>
    isStoredCall(callId, call, descriptorIds));
}

export function isToolAuthorizationDescriptorSnapshotRecord(
  value: unknown,
): value is ToolAuthorizationDescriptorSnapshot {
  if (!isPlainRecord(value) || !isPlainRecord(value.provider) || !isPlainRecord(value.execution)) return false;
  const snapshot = value as unknown as ToolAuthorizationDescriptorSnapshot;
  return hasOnlyKeys(value, ['id', 'provider', 'name', 'invocationName', 'execution', 'inputSchemaDigest']) &&
    hasOnlyKeys(value.provider, ['kind', 'id', 'transport']) &&
    hasOnlyKeys(value.execution, ['mode', 'enabled', 'risk', 'timeoutMs', 'maxResultBytes']) &&
    isIdentity(snapshot.id) &&
    isIdentity(snapshot.name) &&
    isIdentity(snapshot.invocationName) &&
    (TOOL_PROVIDER_KINDS as readonly string[]).includes(snapshot.provider.kind) &&
    isIdentity(snapshot.provider.id) &&
    (TOOL_TRANSPORT_KINDS as readonly string[]).includes(snapshot.provider.transport) &&
    // Released 1.12.0 snapshots may persist the removed 'manual' mode (grants
    // and capability leases copied descriptor.execution verbatim). Accept it
    // so stored state keeps loading; equivalence checks still compare mode
    // strictly, so a legacy snapshot fails closed to a re-grant and the next
    // write normalizes the stored value.
    ((TOOL_EXECUTION_MODES as readonly string[]).includes(snapshot.execution.mode)
      || (snapshot.execution.mode as string) === 'manual') &&
    typeof snapshot.execution.enabled === 'boolean' &&
    (TOOL_RISK_LEVELS as readonly string[]).includes(snapshot.execution.risk) &&
    (snapshot.execution.timeoutMs === undefined || isPositiveNumber(snapshot.execution.timeoutMs)) &&
    (snapshot.execution.maxResultBytes === undefined || isPositiveNumber(snapshot.execution.maxResultBytes)) &&
    typeof snapshot.inputSchemaDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(snapshot.inputSchemaDigest);
}

export function isStoredCall(
  id: string,
  value: unknown,
  descriptorIds: ReadonlySet<string>,
): value is StoredCallAuthorization {
  if (!isPlainRecord(value)) return false;
  const call = value as Partial<StoredCallAuthorization>;
  if (
    !hasOnlyKeys(value, ['descriptorId', 'state', 'fingerprint', 'retryUsed']) ||
    !isIdentity(id) ||
    !isIdentity(call.descriptorId) ||
    !descriptorIds.has(call.descriptorId) ||
    typeof call.retryUsed !== 'boolean'
  ) return false;

  const hasFingerprint = typeof call.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(call.fingerprint);
  return (
    call.state === 'collecting' && call.fingerprint === undefined && !call.retryUsed
  ) || (
    (call.state === 'executing' || call.state === 'consumed') && hasFingerprint
  ) || (
    call.state === 'retryable' && hasFingerprint && !call.retryUsed
  );
}

export const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
export const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
export const SCHEMA_CHILD_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

export function stripSchemaNodeDescriptions(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'description') continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainRecord(item)) {
      normalized[key] = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [name, stripSchemaNodeDescriptions(schema)]),
      );
      continue;
    }
    if (key === 'dependencies' && isPlainRecord(item)) {
      normalized[key] = Object.fromEntries(
        Object.entries(item).map(([name, dependency]) => [
          name,
          Array.isArray(dependency)
            ? dependency
            : stripSchemaNodeDescriptions(dependency),
        ]),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(item)) {
      normalized[key] = item.map(stripSchemaNodeDescriptions);
      continue;
    }
    if (SCHEMA_CHILD_KEYWORDS.has(key)) {
      normalized[key] = Array.isArray(item)
        ? item.map(stripSchemaNodeDescriptions)
        : stripSchemaNodeDescriptions(item);
      continue;
    }
    // const/default/enum/examples are instance data, not schema nodes. Keep
    // their own `description` keys intact and let stable serialization order
    // them without changing semantics.
    normalized[key] = item;
  }
  return normalized;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function assertStateWithinByteBudget(state: ToolAuthorizationState): void {
  const size = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (size > MAX_AUTHORIZATION_STATE_BYTES) {
    throw new ToolAuthorizationError(
      'tool_authorization_storage_limit',
      'Tool authorization storage limit exceeded.',
    );
  }
}

export function optionalIdentity(value: unknown): boolean {
  return value === undefined || isIdentity(value);
}

export function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
