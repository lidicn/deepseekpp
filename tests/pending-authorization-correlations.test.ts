import { describe, expect, it } from 'vitest';
import {
  PendingAuthorizationCorrelations,
  TERMINATED_TOMBSTONE_MAX,
  TERMINATED_TOMBSTONE_TTL_MS,
} from '../core/tool/pending-authorization-correlations';

describe('pending authorization correlations', () => {
  it('turns an early terminal event into a late-activation tombstone', () => {
    const correlations = new PendingAuthorizationCorrelations();
    expect(correlations.begin('main-request-1')).toBe(true);

    correlations.terminate('main-request-1');

    expect(correlations.activate('main-request-1')).toBe(true);
    expect(correlations.begin('main-request-1')).toBe(true);
  });

  it('marks every in-flight augmentation terminal on bridge disconnect', () => {
    const correlations = new PendingAuthorizationCorrelations();
    correlations.begin('main-request-1');
    correlations.begin('main-request-2');

    correlations.terminateAll();

    expect(correlations.activate('main-request-1')).toBe(true);
    expect(correlations.activate('main-request-2')).toBe(true);
  });

  it('rejects duplicate in-flight correlation identities and cleans failed work', () => {
    const correlations = new PendingAuthorizationCorrelations();
    expect(correlations.begin('main-request-1')).toBe(true);
    expect(correlations.begin('main-request-1')).toBe(false);

    correlations.finish('main-request-1');

    expect(correlations.begin('main-request-1')).toBe(true);
  });

  it('evicts abandoned tombstones after the TTL while a fresh tombstone still suppresses', () => {
    let now = 1_000_000;
    const correlations = new PendingAuthorizationCorrelations(() => now);
    correlations.begin('abandoned-stream');
    correlations.terminate('abandoned-stream');

    // Fresh tombstone inserted after the abandoned one crossed its TTL prunes it.
    now += TERMINATED_TOMBSTONE_TTL_MS + 1;
    correlations.begin('recent-stream');
    correlations.terminate('recent-stream');

    expect(correlations.activate('abandoned-stream')).toBe(false);
    expect(correlations.activate('recent-stream')).toBe(true);
  });

  it('bounds the tombstone set with oldest-eviction under a terminateAll burst', () => {
    let now = 2_000_000;
    const correlations = new PendingAuthorizationCorrelations(() => now);
    const ids = Array.from({ length: TERMINATED_TOMBSTONE_MAX + 5 }, (_, index) => `request-${index}`);
    for (const id of ids) correlations.begin(id);
    correlations.terminateAll();

    // The 5 oldest tombstones were evicted to keep the set bounded; the newest
    // burst of terminals always keeps its suppression.
    expect(correlations.activate('request-0')).toBe(false);
    expect(correlations.activate('request-4')).toBe(false);
    expect(correlations.activate(`request-${TERMINATED_TOMBSTONE_MAX - 1}`)).toBe(true);
    expect(correlations.activate(`request-${ids.length - 1}`)).toBe(true);
  });

  it('exposes a documented bound so tombstones cannot outlive the longest stream budget', () => {
    expect(TERMINATED_TOMBSTONE_TTL_MS).toBe(300_000);
    expect(TERMINATED_TOMBSTONE_MAX).toBeGreaterThan(0);
  });
});
