/**
 * Sidepanel chat auth probe retry (第十二批 P0-1).
 *
 * Root cause: GET_AUTH_STATUS is a one-shot probe. If the DeepSeek content
 * script is not ready yet (or tabs.query returns empty for a moment), the
 * sidepanel renders "not logged in" forever. Auth itself is fine — a later
 * manual REFRESH_DEEPSEEK_AUTH succeeds.
 *
 * This helper retries the probe with fixed backoff until authed or delays
 * are exhausted. Delays are injectable so tests can force 0 retries.
 */
export const CHAT_AUTH_RETRY_DELAYS_MS: readonly number[] = [800, 2_500];

export function defaultAuthRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Probe auth until `isAuthed` or delays are exhausted.
 * `delaysMs = []` means a single probe (pre-fix behavior).
 */
export async function loadAuthStatusWithRetry<T>(
  fetchAuth: () => Promise<T>,
  isAuthed: (status: T) => boolean,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? CHAT_AUTH_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultAuthRetrySleep;

  let status = await fetchAuth();
  if (isAuthed(status)) return status;

  for (const delayMs of delaysMs) {
    await sleep(delayMs);
    status = await fetchAuth();
    if (isAuthed(status)) return status;
  }
  return status;
}

export function isChatAuthed(status: {
  hasToken: boolean;
  hasApiKey: boolean;
}): boolean {
  return status.hasToken || status.hasApiKey;
}
