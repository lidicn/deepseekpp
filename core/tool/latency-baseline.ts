// T34: 工具耗时基线纯函数

export interface LatencyStats {
  p50: number;
  p95: number;
  count: number;
}

export function createLatencyBaseline(windowSize = 50) {
  const history: number[] = [];
  return {
    record(ms: number): void {
      history.push(ms);
      if (history.length > windowSize) history.shift();
    },
    stats(): LatencyStats {
      if (history.length === 0) return { p50: 0, p95: 0, count: 0 };
      const sorted = [...history].sort((a, b) => a - b);
      // p50 取下中位数（lower median）：偶数样本取第 (len-1)/2 向下取整位，
      // 延迟基线常规做法；避免原 floor(len*0.5) 在偶数长度上取到上中位数。
      const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      return { p50, p95, count: sorted.length };
    },
    isSlow(ms: number, factor = 3): boolean {
      const { p50 } = this.stats();
      return p50 > 0 && ms > p50 * factor;
    },
  };
}
