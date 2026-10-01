/**
 * descriptor-security.ts — 工具描述符安全快照与等价比较。
 * 职责：描述符快照创建/匹配、安全属性等价比较、存储校验与 schema 规范化。
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
import {
  TOOL_AUTHORIZATION_STORAGE_KEY,
  TOOL_AUTHORIZATION_STATE_VERSION,
  MAX_ACTIVE_GRANTS,
  MAX_CALLS_PER_GRANT,
  MAX_AUTHORIZATION_STATE_BYTES,
  authorizationMutation,
  mutateState,
  pruneState,
  readState,
  isStoredAuthorizationState,
  isStoredGrant,
  isStoredSubject,
  hasValidStoredGrantSessionBinding,
  hasUniqueStoredDescriptorIds,
  hasValidStoredCalls,
  isStoredCall,
  assertStateWithinByteBudget,
  stripSchemaNodeDescriptions,
  stableJsonStringify,
  sortJsonValue,
  optionalIdentity,
  isIdentity,
  isPositiveNumber,
  isNonNegativeInteger,
  isFiniteNumber,
  isPlainRecord,
  hasOnlyKeys,
  providerMatches,
  isExecutableDescriptor,
  assertUniqueDescriptorIds,
  assertSubjectMatches,
  assertOwnerDocumentMatches,
  assertSubjectMatchesWithoutBinding,
  cloneSubject,
  optionalIdentityMismatch,
  normalizeChatSessionId,
  requireIdentity,
  requireGrant,
  sha256,
  isToolAuthorizationDescriptorSnapshotRecord,
  type StateMutation,
  type ToolAuthorizationState,
  type StoredToolAuthorizationGrant,
  type StoredCallAuthorization,
  type StoredCallState,
  ToolAuthorizationError,
} from './authorization-types';

export async function createToolAuthorizationDescriptorSnapshot(
  descriptor: ToolDescriptor,
): Promise<ToolAuthorizationDescriptorSnapshot> {
  return {
    id: descriptor.id,
    provider: {
      kind: descriptor.provider.kind,
      id: descriptor.provider.id,
      transport: descriptor.provider.transport,
    },
    name: descriptor.name,
    invocationName: descriptor.invocationName,
    execution: { ...descriptor.execution },
    inputSchemaDigest: await createInputSchemaSecurityDigest(descriptor.inputSchema),
  };
}

export async function toolDescriptorMatchesAuthorizationSnapshot(
  descriptor: ToolDescriptor,
  snapshot: ToolAuthorizationDescriptorSnapshot,
): Promise<boolean> {
  return descriptor.id === snapshot.id &&
    descriptor.name === snapshot.name &&
    descriptor.invocationName === snapshot.invocationName &&
    providerMatches(descriptor.provider, snapshot.provider) &&
    stableJsonStringify(descriptor.execution) === stableJsonStringify(snapshot.execution) &&
    await createInputSchemaSecurityDigest(descriptor.inputSchema) === snapshot.inputSchemaDigest;
}

export async function haveEquivalentToolDescriptorSecurity(
  left: ToolDescriptor,
  right: ToolDescriptor,
): Promise<boolean> {
  return toolDescriptorMatchesAuthorizationSnapshot(
    right,
    await createToolAuthorizationDescriptorSnapshot(left),
  );
}

export async function createToolCallFingerprint(
  call: ToolCall,
  descriptorId: string,
): Promise<string> {
  return sha256(stableJsonStringify({
    descriptorId,
    name: call.name,
    invocationName: call.invocationName ?? null,
    payload: call.payload,
  }));
}

/**
 * 递归删除布尔形态的 additionalProperties（false/true）。
 * 对象形态（如 {type:'string'}，承载 map 值类型语义）保留。
 * v1.15 授权兼容：P0-b 删除了布尔 additionalProperties，旧授权快照
 * 是按老 schema 计算的摘要。摘要计算前统一剥离布尔形态，使摘要对该字段不变，
 * 避免升级后已授权工具误报"授权已过期"（旧快照仍会触发一次性重授权，此后不再误报）。
 */
function stripBooleanAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBooleanAdditionalProperties);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "additionalProperties" && typeof v === "boolean") continue;
      result[key] = stripBooleanAdditionalProperties(v);
    }
    return result;
  }
  return value;
}

export async function createInputSchemaSecurityDigest(value: unknown): Promise<string> {
  return sha256(stableJsonStringify(stripSchemaNodeDescriptions(stripBooleanAdditionalProperties(value))));
}
