/**
 * 串行化异步队列。
 *
 * 2026-10-22 真机定位：content script 里 `recordAgentStartDecision` 原本是
 * 裸的 read-modify-write，没有串行化：
 *
 *   void chrome.storage.local.get(KEY).then((data) => {
 *     const next = [...prev, entry].slice(-LIMIT);
 *     return chrome.storage.local.set({ [KEY]: next });
 *   });
 *
 * 两个几乎同时发起的写入会互相吞掉：
 *   A 读 [x] → B 读 [x] → A 写 [x,A] → B 写 [x,B]   ← A 的条目丢失
 *
 * 实证：加了两阶段锚点等待后，探针能证明延长窗确实跑了
 * （`anchor_find_probe` 里 waitMs 从 15000 变成 120000），但配套的
 * `anchor_extended_wait` 条目从未落盘 —— 它被并发的 `anchor_find_probe`
 * 覆盖了。排查过程中大量「诊断缺失」都是这个竞态，而不是探针没触发。
 *
 * 队列语义：
 * - 所有任务按入队顺序**串行**执行，前一个 settle 后才开始下一个
 * - 单个任务抛错不会中断队列（错误由调用方在任务内部处理，
 *   这里只保证链不破）
 */
export type SerializedQueue = <T>(operation: () => Promise<T>) => Promise<T | undefined>;

export function createSerializedQueue(): SerializedQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    const result = tail.then(
      () => operation(),
      // 前一个失败也不能卡死后续任务
      () => operation(),
    );
    // 链上只关心「跑完」，不传播错误，避免一次失败永久毒化队列。
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then(
      (value) => value,
      () => undefined,
    );
  };
}
