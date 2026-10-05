/**
 * A `terminated` tombstone only needs to live as long as the terminated stream
 * could still deliver a late `activate()`. Unbounded tombstones leaked for the
 * page lifetime whenever a stream was abandoned (activate/finish never arrived
 * after `terminate`/`terminateAll`), so insertions are timestamped and pruned
 * to a documented TTL with an additional oldest-eviction size cap. The cap is
 * only hit by abnormal bursts; a fresh terminal always outranks an older one.
 * The TTL matches `INLINE_AGENT_STEP_TIMEOUT_MS` (core/inline-agent/types.ts),
 * the longest single-stream budget in this repo.
 */
export const TERMINATED_TOMBSTONE_TTL_MS = 300_000;
export const TERMINATED_TOMBSTONE_MAX = 512;

export class PendingAuthorizationCorrelations {
  private readonly pending = new Set<string>();
  private readonly terminated = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  begin(correlationId: string): boolean {
    if (this.pending.has(correlationId)) return false;
    this.pending.add(correlationId);
    return true;
  }

  terminate(correlationId: string): void {
    if (this.pending.has(correlationId)) {
      this.recordTerminated(correlationId);
    }
  }

  terminateAll(): void {
    for (const correlationId of this.pending) this.recordTerminated(correlationId);
  }

  activate(correlationId: string): boolean {
    this.pruneTerminated();
    const ended = this.terminated.delete(correlationId);
    this.pending.delete(correlationId);
    return ended;
  }

  finish(correlationId: string): void {
    this.pending.delete(correlationId);
    this.terminated.delete(correlationId);
  }

  private recordTerminated(correlationId: string): void {
    const now = this.now();
    this.terminated.delete(correlationId);
    this.terminated.set(correlationId, now);
    this.pruneTerminated(now);
  }

  private pruneTerminated(now: number = this.now()): void {
    for (const [correlationId, insertedAt] of this.terminated) {
      if (now - insertedAt > TERMINATED_TOMBSTONE_TTL_MS) {
        this.terminated.delete(correlationId);
      }
    }
    while (this.terminated.size > TERMINATED_TOMBSTONE_MAX) {
      const oldest = this.terminated.keys().next();
      if (oldest.done) break;
      this.terminated.delete(oldest.value);
    }
  }
}
