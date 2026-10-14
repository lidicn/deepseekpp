/**
 * Bounded diagnostic log buffer with chrome.storage.local persistence.
 *
 * The buffer retains the most recent operational events (tool starts,
 * authorization denials, tool results, transport failures) so the user can
 * export a compact diagnostic payload without exposing secrets.
 *
 * Persistence: entries are mirrored to chrome.storage.local so that a
 * service-worker restart does not lose the diagnostic trail.  The in-memory
 * buffer remains the authoritative read path; storage is write-behind.
 */

export type DiagnosticLogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  ts: number;
  level: DiagnosticLogLevel;
  source: string;
  message: string;
  /** Short context (never raw payloads or credentials). */
  details?: string;
}

export interface DiagnosticLogBuffer {
  record(entry: Omit<DiagnosticLogEntry, 'ts'>): void;
  snapshot(): readonly DiagnosticLogEntry[];
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const STORAGE_KEY = 'dpp_diagnostic_logs';

/** How many entries to persist to chrome.storage.local (fewer than in-memory). */
const PERSISTED_MAX_ENTRIES = 300;

export function createDiagnosticLogBuffer(
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
): DiagnosticLogBuffer {
  let entries: DiagnosticLogEntry[] = [];
  let totalBytes = 0;
  let storageWritePending = false;

  const entrySize = (entry: DiagnosticLogEntry): number =>
    JSON.stringify(entry).length;

  const evict = (): void => {
    while (entries.length > 0 && (
      entries.length > maxEntries || totalBytes > maxBytes
    )) {
      const removed = entries.shift();
      if (removed) totalBytes -= entrySize(removed);
    }
  };

  /** Write-behind persist: schedule a single microtask to flush recent entries. */
  const persist = (): void => {
    if (storageWritePending) return;
    storageWritePending = true;
    queueMicrotask(() => {
      storageWritePending = false;
      try {
        const recent = entries.slice(-PERSISTED_MAX_ENTRIES);
        void chrome.storage.local.set({ [STORAGE_KEY]: recent });
      } catch {
        // Storage may be unavailable (e.g. in tests); ignore silently.
      }
    });
  };

  /** Restore from chrome.storage.local on startup. */
  const restore = (): void => {
    try {
      void chrome.storage.local.get(STORAGE_KEY).then((data) => {
        const saved = data?.[STORAGE_KEY];
        if (Array.isArray(saved) && saved.length > 0) {
          entries = saved;
          totalBytes = saved.reduce((sum, e) => sum + entrySize(e), 0);
        }
      });
    } catch {
      // Storage unavailable; start empty.
    }
  };

  // Restore on module load.
  restore();

  return {
    record(entry) {
      const stamped: DiagnosticLogEntry = { ...entry, ts: Date.now() };
      entries.push(stamped);
      totalBytes += entrySize(stamped);
      evict();
      persist();
    },
    snapshot() {
      return [...entries];
    },
    clear() {
      entries = [];
      totalBytes = 0;
      try {
        void chrome.storage.local.remove(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  };
}

/** Process-wide buffer used by the background tool runtime. */
export const diagnosticLogBuffer = createDiagnosticLogBuffer();
