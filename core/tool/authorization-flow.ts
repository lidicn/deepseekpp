/**
 * authorization-flow.ts — 工具授权流程。
 * 职责：创建/执行/完成/关闭授权、外部 payload 分块授权、审计触发、授权结果创建。
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
import {
  TOOL_AUTHORIZATION_TTL_MS,
  MAX_ACTIVE_GRANTS,
  MAX_CALLS_PER_GRANT,
  mutateState,
  pruneState,
  providerMatches,
  isExecutableDescriptor,
  assertUniqueDescriptorIds,
  assertSubjectMatches,
  assertSubjectMatchesWithoutBinding,
  assertOwnerDocumentMatches,
  cloneSubject,
  optionalIdentityMismatch,
  normalizeChatSessionId,
  requireIdentity,
  requireGrant,
  type CreateToolAuthorizationInput,
  type AuthorizedToolExecution,
  type StoredToolAuthorizationGrant,
  type ToolAuthorizationState,
  ToolAuthorizationError,
} from './authorization-types';
import {
  createToolAuthorizationDescriptorSnapshot,
  toolDescriptorMatchesAuthorizationSnapshot,
  createToolCallFingerprint,
} from './descriptor-security';

export async function createToolAuthorization(
  input: CreateToolAuthorizationInput,
): Promise<ToolAuthorizationGrantSummary> {
  const requestId = requireIdentity(input.requestId, 'requestId');
  const now = input.now ?? Date.now();
  // The page request body is untrusted. Bind this grant only to the session
  // Chrome reports for the receiving content document, never to its declared
  // chat_session_id.
  const chatSessionId = normalizeChatSessionId(input.subject.chatSessionId);

  const descriptors = input.descriptors.filter(isExecutableDescriptor);
  assertUniqueDescriptorIds(descriptors);
  const id = crypto.randomUUID();
  const grant: StoredToolAuthorizationGrant = {
    id,
    requestId,
    trigger: input.trigger,
    chatSessionId,
    taskId: input.taskId,
    runId: input.runId,
    automationId: input.automationId,
    automationRunId: input.automationRunId,
    subject: cloneSubject(input.subject),
    descriptors: await Promise.all(descriptors.map(createToolAuthorizationDescriptorSnapshot)),
    calls: {},
    issuedAt: now,
    expiresAt: now + TOOL_AUTHORIZATION_TTL_MS,
    localSkillDir: input.localSkillDir ?? undefined,
  };

  await mutateState((state) => {
    pruneState(state, now);
    if (Object.keys(state.grants).length >= MAX_ACTIVE_GRANTS) {
      throw new ToolAuthorizationError(
        'tool_authorization_grant_limit',
        'Too many tool authorizations are active.',
      );
    }
    state.grants[id] = grant;
    return { result: undefined, changed: true };
  });

  return {
    id,
    requestId,
    trigger: input.trigger,
    chatSessionId,
    descriptors: [...descriptors],
    expiresAt: grant.expiresAt,
  };
}

export async function authorizeToolExecution(
  call: ToolCall,
  context: RuntimeToolAuthorizationContext,
  currentDescriptors: readonly ToolDescriptor[],
  now: number = Date.now(),
): Promise<AuthorizedToolExecution> {
  if (context.kind === 'trusted') {
    const descriptor = resolveTrustedDescriptor(call, currentDescriptors);
    return {
      call: canonicalizeCall(call, descriptor, {
        trigger: context.trigger,
        requestId: context.requestId,
        chatSessionId: normalizeChatSessionId(context.chatSessionId),
        taskId: context.taskId,
        runId: context.runId,
        automationId: context.automationId,
        automationRunId: context.automationRunId,
      }),
      descriptor,
      trigger: context.trigger,
      reservation: null,
    };
  }

  return mutateState(async (state) => {
    const grant = requireGrant(state, context.grantId, now);
    pruneState(state, now);
    assertSubjectMatches(grant, context.subject);
    assertCallSourceMatchesGrant(call, grant);
    const { snapshot, descriptor } = await resolveGrantedDescriptor(call, grant, currentDescriptors);
    const callId = requireIdentity(call.id, 'call.id');
    const fingerprint = await createToolCallFingerprint(call, snapshot.id);
    const existing = grant.calls[callId];
    if (existing && existing.state !== 'retryable' && existing.state !== 'collecting') {
      throw new ToolAuthorizationError(
        'tool_call_replayed',
        `Tool call ${callId} has already been reserved or consumed.`,
      );
    }
    if (existing && existing.descriptorId !== snapshot.id) {
      throw new ToolAuthorizationError(
        'tool_call_identity_mismatch',
        `Tool call ${callId} is already bound to another descriptor.`,
      );
    }
    if (existing?.fingerprint && existing.fingerprint !== fingerprint) {
      throw new ToolAuthorizationError(
        'tool_call_identity_mismatch',
        `Tool call ${callId} retry payload does not match its original authorization.`,
      );
    }
    if (!existing && Object.keys(grant.calls).length >= MAX_CALLS_PER_GRANT) {
      throw new ToolAuthorizationError(
        'tool_authorization_call_limit',
        'Tool authorization call limit exceeded.',
      );
    }

    grant.calls[callId] = {
      descriptorId: snapshot.id,
      state: 'executing',
      fingerprint,
      retryUsed: existing?.state === 'retryable' ? true : existing?.retryUsed ?? false,
    };
    return {
      result: {
        call: canonicalizeCall(call, descriptor, grant),
        descriptor,
        trigger: grant.trigger,
        reservation: { grantId: grant.id, callId },
        externalPayloadNamespace: grant.id,
      },
      changed: true,
    };
  });
}

export async function authorizeExternalToolPayloadChunk(input: {
  grantId: string;
  subject: ToolAuthorizationSubject;
  callId: string;
  invocationName: string;
  currentDescriptors: readonly ToolDescriptor[];
  now?: number;
}): Promise<{ namespace: string; expiresAt: number }> {
  const callId = requireIdentity(input.callId, 'callId');
  const invocationName = requireIdentity(input.invocationName, 'invocationName');
  const now = input.now ?? Date.now();

  return mutateState(async (state) => {
    const grant = requireGrant(state, input.grantId, now);
    const pruned = pruneState(state, now);
    const subjectChanged = assertSubjectMatches(grant, input.subject);
    const snapshots = grant.descriptors.filter((item) => item.invocationName === invocationName);
    if (snapshots.length !== 1) {
      throw new ToolAuthorizationError(
        'tool_not_authorized',
        `Tool invocation ${invocationName} is not authorized by this request.`,
      );
    }
    const snapshot = snapshots[0];
    await requireCurrentDescriptor(snapshot, input.currentDescriptors);

    const existing = grant.calls[callId];
    if (existing && existing.state !== 'collecting') {
      throw new ToolAuthorizationError(
        'tool_call_replayed',
        `Tool call ${callId} is no longer accepting payload chunks.`,
      );
    }
    if (existing && existing.descriptorId !== snapshot.id) {
      throw new ToolAuthorizationError(
        'tool_call_identity_mismatch',
        `Tool call ${callId} is already bound to another descriptor.`,
      );
    }
    if (!existing && Object.keys(grant.calls).length >= MAX_CALLS_PER_GRANT) {
      throw new ToolAuthorizationError(
        'tool_authorization_call_limit',
        'Tool authorization call limit exceeded.',
      );
    }

    if (!existing) {
      grant.calls[callId] = {
        descriptorId: snapshot.id,
        state: 'collecting',
        retryUsed: false,
      };
    }
    return {
      result: { namespace: grant.id, expiresAt: grant.expiresAt },
      changed: pruned || subjectChanged || !existing,
    };
  });
}

export async function completeToolExecutionAuthorization(
  reservation: AuthorizedToolExecution['reservation'],
  result?: ToolResult,
): Promise<void> {
  if (!reservation) return;
  await mutateState((state) => {
    const grant = state.grants[reservation.grantId];
    const call = grant?.calls[reservation.callId];
    if (!call) return { result: undefined, changed: false };
    call.state = isRetryableWebFetchPermissionPrecondition(call.descriptorId, result) &&
      !call.retryUsed
      ? 'retryable'
      : 'consumed';
    return { result: undefined, changed: true };
  });
}

export async function closeToolAuthorization(
  grantId: string,
  subject: ToolAuthorizationSubject,
): Promise<void> {
  await mutateState((state) => {
    const grant = state.grants[grantId];
    if (!grant) return { result: undefined, changed: false };
    assertOwnerDocumentMatches(grant, subject);
    delete state.grants[grantId];
    return { result: undefined, changed: true };
  });
}

/**
 * Read the background-validated local-skill directory on the grant (Review #2).
 * Execution-time cwd is derived solely from this; any page/model-supplied
 * localSkillDir is ignored. Only this field is exposed, not the whole grant.
 */
export async function getGrantLocalSkillDir(grantId: string): Promise<string | undefined> {
  const grant = await mutateState(async (state) => {
    const g = state.grants[grantId];
    return { result: g ? g.localSkillDir : undefined, changed: false };
  });
  return grant;
}

export async function getToolAuthorizationAuditTrigger(
  call: ToolCall,
  context: RuntimeToolAuthorizationContext,
  now: number = Date.now(),
): Promise<ToolExecutionTrigger | null> {
  if (context.kind === 'trusted') return context.trigger;
  try {
    return await mutateState((state) => {
      const grant = requireGrant(state, context.grantId, now);
      assertSubjectMatchesWithoutBinding(grant, context.subject);
      assertCallSourceMatchesGrant(call, grant);
      return { result: grant.trigger, changed: false };
    });
  } catch (error) {
    if (error instanceof ToolAuthorizationError) return null;
    throw error;
  }
}

export function createToolAuthorizationResult(
  error: ToolAuthorizationError,
  call?: Pick<ToolCall, 'id' | 'name' | 'descriptorId' | 'provider'>,
  summary: string = 'Tool authorization rejected',
  hint?: string,
): ToolResult {
  return {
    ok: false,
    summary,
    detail: hint ? `${error.message}。${hint}` : error.message,
    callId: call?.id,
    name: call?.name,
    descriptorId: call?.descriptorId,
    provider: call?.provider,
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
    },
  };
}

function resolveTrustedDescriptor(
  call: ToolCall,
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor {
  const descriptor = resolveDescriptorClaim(call, descriptors);
  if (!descriptor) {
    throw new ToolAuthorizationError('tool_unsupported', `Unsupported tool: ${call.name}`);
  }
  if (!isExecutableDescriptor(descriptor)) {
    throw new ToolAuthorizationError('tool_disabled', `Tool ${descriptor.name} is disabled.`);
  }
  assertCallDescriptorClaims(call, descriptor);
  return descriptor;
}

async function resolveGrantedDescriptor(
  call: ToolCall,
  grant: StoredToolAuthorizationGrant,
  currentDescriptors: readonly ToolDescriptor[],
): Promise<{ snapshot: ToolAuthorizationDescriptorSnapshot; descriptor: ToolDescriptor }> {
  const snapshot = resolveSnapshotClaim(call, grant.descriptors);
  if (!snapshot) {
    throw new ToolAuthorizationError(
      'tool_not_authorized',
      `Tool ${call.name} was not authorized for request ${grant.requestId}.`,
    );
  }
  assertCallSnapshotClaims(call, snapshot);
  return { snapshot, descriptor: await requireCurrentDescriptor(snapshot, currentDescriptors) };
}

function resolveDescriptorClaim(
  call: ToolCall,
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor | null {
  if (call.descriptorId) {
    return descriptors.find((descriptor) => descriptor.id === call.descriptorId) ?? null;
  }
  const candidates = call.invocationName
    ? descriptors.filter((descriptor) => descriptor.invocationName === call.invocationName)
    : descriptors.filter((descriptor) => descriptor.name === call.name);
  const providerCandidates = call.provider
    ? candidates.filter((descriptor) => providerMatches(descriptor.provider, call.provider!))
    : candidates;
  return providerCandidates.length === 1 ? providerCandidates[0] : null;
}

function resolveSnapshotClaim(
  call: ToolCall,
  snapshots: readonly ToolAuthorizationDescriptorSnapshot[],
): ToolAuthorizationDescriptorSnapshot | null {
  if (call.descriptorId) {
    return snapshots.find((snapshot) => snapshot.id === call.descriptorId) ?? null;
  }
  const candidates = call.invocationName
    ? snapshots.filter((snapshot) => snapshot.invocationName === call.invocationName)
    : snapshots.filter((snapshot) => snapshot.name === call.name);
  const providerCandidates = call.provider
    ? candidates.filter((snapshot) => providerMatches(snapshot.provider, call.provider!))
    : candidates;
  return providerCandidates.length === 1 ? providerCandidates[0] : null;
}

async function requireCurrentDescriptor(
  snapshot: ToolAuthorizationDescriptorSnapshot,
  currentDescriptors: readonly ToolDescriptor[],
): Promise<ToolDescriptor> {
  const descriptor = currentDescriptors.find((candidate) => candidate.id === snapshot.id);
  if (
    !descriptor ||
    !isExecutableDescriptor(descriptor) ||
    !await toolDescriptorMatchesAuthorizationSnapshot(descriptor, snapshot)
  ) {
    throw new ToolAuthorizationError(
      'tool_authorization_stale',
      `Tool authorization for ${snapshot.name} is stale.`,
    );
  }
  return descriptor;
}

function assertCallDescriptorClaims(call: ToolCall, descriptor: ToolDescriptor): void {
  if (
    call.name !== descriptor.name ||
    (call.invocationName !== undefined && call.invocationName !== descriptor.invocationName) ||
    (call.provider !== undefined && !providerMatches(call.provider, descriptor.provider))
  ) {
    throw new ToolAuthorizationError(
      'tool_descriptor_mismatch',
      `Tool call claims do not match descriptor ${descriptor.id}.`,
    );
  }
}

function assertCallSnapshotClaims(
  call: ToolCall,
  snapshot: ToolAuthorizationDescriptorSnapshot,
): void {
  if (
    call.name !== snapshot.name ||
    (call.invocationName !== undefined && call.invocationName !== snapshot.invocationName) ||
    (call.provider !== undefined && !providerMatches(call.provider, snapshot.provider))
  ) {
    throw new ToolAuthorizationError(
      'tool_descriptor_mismatch',
      `Tool call claims do not match authorized descriptor ${snapshot.id}.`,
    );
  }
}

function assertCallSourceMatchesGrant(call: ToolCall, grant: StoredToolAuthorizationGrant): void {
  const source = call.source;
  if (!source) {
    throw new ToolAuthorizationError('tool_source_missing', 'Authorized tool call source is missing.');
  }
  if (
    source.trigger !== grant.trigger ||
    source.requestId !== grant.requestId ||
    normalizeChatSessionId(source.chatSessionId) !== grant.chatSessionId ||
    optionalIdentityMismatch(source.taskId, grant.taskId) ||
    optionalIdentityMismatch(source.runId, grant.runId) ||
    optionalIdentityMismatch(source.automationId, grant.automationId) ||
    optionalIdentityMismatch(source.automationRunId, grant.automationRunId)
  ) {
    throw new ToolAuthorizationError(
      'tool_session_mismatch',
      'Tool call source does not match its extension-owned authorization context.',
    );
  }
}

function canonicalizeCall(
  call: ToolCall,
  descriptor: ToolDescriptor,
  source: Pick<StoredToolAuthorizationGrant, 'trigger' | 'requestId' | 'chatSessionId' | 'taskId' | 'runId' | 'automationId' | 'automationRunId'>,
): ToolCall {
  return {
    ...call,
    id: call.id ?? crypto.randomUUID(),
    descriptorId: descriptor.id,
    provider: descriptor.provider,
    name: descriptor.name,
    invocationName: descriptor.invocationName,
    source: {
      ...call.source,
      trigger: source.trigger,
      requestId: source.requestId,
      chatSessionId: source.chatSessionId,
      taskId: source.taskId,
      runId: source.runId,
      automationId: source.automationId,
      automationRunId: source.automationRunId,
    },
  };
}
