import { isExpectedMissingRuntimeMessageReceiverError } from '../../core/messaging/broadcast';

export interface DeepSeekAuthRefreshTab {
  readonly id?: number | null;
}

export interface DeepSeekAuthRefreshDependencies {
  readonly sendMessage: (tabId: number) => Promise<unknown>;
  readonly reportError: (code: string, error: unknown) => void;
}

/**
 * P0-1: distinguish "no DeepSeek tabs" from "tabs exist but content script
 * is not connected" so callers can decide whether a short retry is useful.
 */
export type DeepSeekAuthRefreshOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_tabs' | 'no_connection' };

export async function refreshDeepSeekAuthFromTabs(
  tabs: readonly DeepSeekAuthRefreshTab[],
  dependencies: DeepSeekAuthRefreshDependencies,
): Promise<DeepSeekAuthRefreshOutcome> {
  const candidates = tabs.filter((tab) => Boolean(tab.id));
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_tabs' };
  }

  const unexpectedErrors: unknown[] = [];
  let sawMissingReceiver = false;
  for (const tab of candidates) {
    if (!tab.id) continue;
    try {
      const response = await dependencies.sendMessage(tab.id);
      if (hasAuthToken(response)) return { ok: true };
    } catch (error) {
      if (isExpectedMissingRuntimeMessageReceiverError(error)) {
        sawMissingReceiver = true;
        continue;
      }
      unexpectedErrors.push(error);
      dependencies.reportError('auth_refresh_tab_delivery_failed', error);
    }
  }

  if (unexpectedErrors.length > 0) {
    throw new AggregateError(
      unexpectedErrors,
      'DeepSeek auth refresh failed for every reachable tab.',
    );
  }
  return {
    ok: false,
    reason: sawMissingReceiver ? 'no_connection' : 'no_tabs',
  };
}

function hasAuthToken(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { hasToken?: unknown }).hasToken === true,
  );
}
