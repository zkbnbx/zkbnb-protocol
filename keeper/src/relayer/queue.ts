/**
 * Relayer concurrency primitives — privacy/PRIVACY-SPEC.md §5.3: sends are serialised (one nonce at a time), the
 * nullifiers of an accepted spend are locked while it is in flight, and each client IP has a token bucket.
 * Nothing here records who asked: the rate limiter keeps only a token count per IP, in memory, and forgets idle IPs.
 */

/** Runs tasks one after another; a failing task never blocks the next. */
export class SendQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => {
      this.pending--;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  get size(): number {
    return this.pending;
  }
}

/**
 * Keys a relayer has accepted and not yet seen settle (nullifiers of a spend, a vault with a relay pending). A
 * retry or a double submit is refused instead of paying for a revert. Entries expire after `ttlMs`; a held
 * request locks with ttl = Infinity until it is submitted or dropped.
 */
export class InflightLock {
  private readonly held = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}
  /** Take every key or none; false when any of them is already held. */
  take(keys: readonly string[], now = Date.now(), ttlMs = this.ttlMs): boolean {
    for (const [k, t] of this.held) if (t < now) this.held.delete(k);
    if (keys.some((k) => this.held.has(k))) return false;
    for (const k of keys) this.held.set(k, now + ttlMs);
    return true;
  }
  has(key: string, now = Date.now()): boolean {
    const t = this.held.get(key);
    return t !== undefined && t >= now;
  }
  release(keys: readonly string[]) {
    for (const k of keys) this.held.delete(k);
  }
}
export const nullifierLockKeys = (ns: readonly bigint[]): string[] => ns.map((n) => `nullifier:${n}`);
export const vaultLockKey = (vault: string): string => `vault:${vault.toLowerCase()}`;

/** Per-key token bucket: `rate` tokens per second, at most `burst`. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly maxKeys = 10_000,
  ) {}
  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
      b.at = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  /** Forget every bucket that has refilled completely (nothing to remember about that IP). */
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.rate >= this.burst) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
  get size(): number {
    return this.buckets.size;
  }
}
