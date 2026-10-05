import type { ConversationExportRequest } from './types';

/**
 * DPP-01 ruling A: the session cap is a user-facing setting, defaulting to 500.
 * Listing exports are bounded by the stored cap rather than by whatever an
 * untrusted page-side caller asked for.
 */
export const CONVERSATION_EXPORT_SESSION_LIMIT_STORAGE_KEY = 'dpp_export_session_limit';

interface LocalStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
}

/** The stored cap, or null when unset or not a positive integer. */
export async function readConversationExportSessionLimit(
  storage: LocalStorageLike,
): Promise<number | null> {
  const result = await storage.get(CONVERSATION_EXPORT_SESSION_LIMIT_STORAGE_KEY);
  return normalizeStoredSessionLimit(result[CONVERSATION_EXPORT_SESSION_LIMIT_STORAGE_KEY]);
}

export function normalizeStoredSessionLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * Apply the stored cap to a request. An explicit-session request is already
 * bounded by its own session ids, so it is returned untouched.
 */
export function applyStoredSessionLimit(
  request: ConversationExportRequest,
  storedLimit: number | null,
): ConversationExportRequest {
  if (storedLimit === null || request.sessionIds?.length) return request;
  return { ...request, sessionLimit: storedLimit };
}
