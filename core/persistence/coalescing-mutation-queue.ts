import { createSerialOperationQueue } from './serial-operation-queue';

interface PendingMutation<Input, Output> {
  input: Input;
  resolve: (value: Output) => void;
  reject: (reason: unknown) => void;
}

interface MutationBatch<Input, Output> {
  pending: Array<PendingMutation<Input, Output>>;
}

/**
 * Typed outcome for a burst whose physical write-back was intentionally
 * dropped because an observed barrier (a user-initiated clear) superseded it
 * between the burst read and the write-back. Flusher implementations reject
 * with this error instead of returning a wrong-length output array, so callers
 * see an explicit "burst_superseded" result rather than a fabricated `{}`.
 */
export class BurstSupersededError extends Error {
  readonly code = 'burst_superseded' as const;

  constructor(message = 'Coalescing burst was superseded by an observed barrier.') {
    super(message);
    this.name = 'BurstSupersededError';
  }
}

export interface CoalescingMutationQueue<Input, Output> {
  mutate(input: Input): Promise<Output>;
  barrier<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Coalesces adjacent, unobserved mutations while preserving one store-local FIFO.
 * Reads and clears are barriers, and a batch is sealed before its first await,
 * so work arriving later cannot cross an already-observed operation boundary.
 */
export function createCoalescingMutationQueue<Input, Output>(
  flush: (inputs: readonly Input[]) => Promise<readonly Output[]>,
): CoalescingMutationQueue<Input, Output> {
  const operations = createSerialOperationQueue();
  let openBatch: MutationBatch<Input, Output> | null = null;

  const settleBatch = async (batch: MutationBatch<Input, Output>): Promise<void> => {
    if (openBatch === batch) openBatch = null;
    try {
      const outputs = await flush(batch.pending.map(({ input }) => input));
      if (outputs.length !== batch.pending.length) {
        // A wrong-length result is a flusher bug, never a success. Superseded
        // bursts must be signalled by rejecting with a typed BurstSupersededError.
        batch.pending.forEach((pending) => pending.reject(new Error(
          `Coalescing flush returned ${outputs.length} outputs for ${batch.pending.length} pending mutations.`,
        )));
        return;
      }
      batch.pending.forEach((pending, index) => pending.resolve(outputs[index]));
    } catch (error) {
      batch.pending.forEach((pending) => pending.reject(error));
    }
  };

  const createBatch = (): MutationBatch<Input, Output> => {
    const batch: MutationBatch<Input, Output> = { pending: [] };
    openBatch = batch;
    void operations.run(() => settleBatch(batch));
    return batch;
  };

  return Object.freeze({
    mutate(input: Input): Promise<Output> {
      const batch = openBatch ?? createBatch();
      return new Promise<Output>((resolve, reject) => {
        batch.pending.push({ input, resolve, reject });
      });
    },
    barrier<T>(operation: () => Promise<T>): Promise<T> {
      openBatch = null;
      return operations.run(operation);
    },
  });
}
