/**
 * authorization.ts — 工具授权门面（re-export 兼容层）。
 * 原 34.8KB 巨石已拆分为 authorization-types / authorization-flow / descriptor-security。
 */
export {
  TOOL_AUTHORIZATION_STORAGE_KEY,
  TOOL_AUTHORIZATION_TTL_MS,
  authorizationMutation,
} from './authorization-types';
export type {
  CreateToolAuthorizationInput,
  AuthorizedToolExecution,
  ToolAuthorizationState,
  StoredToolAuthorizationGrant,
  StoredCallAuthorization,
  StoredCallState,
} from './authorization-types';
export { ToolAuthorizationError } from './authorization-types';
export {
  createToolAuthorization,
  authorizeToolExecution,
  authorizeExternalToolPayloadChunk,
  completeToolExecutionAuthorization,
  closeToolAuthorization,
  getGrantLocalSkillDir,
  getToolAuthorizationAuditTrigger,
  createToolAuthorizationResult,
} from './authorization-flow';
export {
  createToolAuthorizationDescriptorSnapshot,
  toolDescriptorMatchesAuthorizationSnapshot,
  haveEquivalentToolDescriptorSecurity,
} from './descriptor-security';
export { isToolAuthorizationDescriptorSnapshotRecord } from './authorization-types';
