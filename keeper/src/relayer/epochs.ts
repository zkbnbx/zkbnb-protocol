/**
 * GET /relay/epochs — privacy/PRIVACY-SPEC.md §5.3: the current epoch of every direction of ALL active coins (no coin
 * parameter, so the request says nothing about what the user looks at), served from a cache refreshed every 15 s,
 * the same bytes for everyone. The rows are built by pool-feed's `buildEpochsJson`, so the relayer's answer is
 * identical to the keeper's `epochs.json`.
 */
import type { EpochsJson } from "./protocol.js";

export const EPOCHS_REFRESH_MS = 15_000;

export class EpochsCache {
  private body: string | null = null;
  private at = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly build: () => Promise<EpochsJson>,
    private readonly refreshMs = EPOCHS_REFRESH_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rebuild now (the server also calls this on a timer). A failed build keeps the previous body. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const j = await this.build();
        this.body = JSON.stringify(j);
        this.at = this.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** The cached JSON text; builds once when empty or stale (twice the refresh period). */
  async get(): Promise<string | null> {
    if (this.body === null || this.now() - this.at > 2 * this.refreshMs) {
      try {
        await this.refresh();
      } catch {
        // serve the stale body if there is one
      }
    }
    return this.body;
  }

  get updatedAtMs(): number {
    return this.at;
  }
}
