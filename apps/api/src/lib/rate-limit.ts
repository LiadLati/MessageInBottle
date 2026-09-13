// Fixed-window in-memory rate limiter for authentication endpoints. Keys are opaque strings
// (client address, username); state lives in the process, which is the deployment shape of
// this stage (one API process). Windows that have expired are dropped lazily.
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  // Counts one attempt against the key and says whether it may proceed.
  hit(key: string, rule: RateLimitRule): RateLimitDecision {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + rule.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    entry.count += 1;
    if (entry.count > rule.limit) return { allowed: false, retryAfterMs: entry.resetAt - t };
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(t: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}
