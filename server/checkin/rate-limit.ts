// 利用者単位のスライディングウィンドウ・レート制限 (プロセス内メモリ)。
// GPS チェックイン (CONTRACTS §6 G3) の rate_limited 判定に使う。

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** 1 回分を消費できれば true、 窓内の上限に達していれば false (消費しない)。 */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.prune(now);
    return true;
  }

  /** 窓を過ぎたキーを掃除してメモリを有界に保つ。 */
  private prune(now: number): void {
    if (this.hits.size < 1024) return;
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
