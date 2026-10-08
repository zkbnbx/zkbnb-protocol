/**
 * Held requests — privacy/PRIVACY-SPEC.md §5.3 "Held intents" and §7 (`v1migrate` `notBefore`).
 *
 * A held request is stored encrypted at rest (AES-256-GCM, key RELAYER_HELD_KEY, the ticket as associated data),
 * one file per request, and indexed in memory by ticket and by its nullifiers (a second request spending the same
 * note is refused while one is held). A poller (`tick`) decides per request: intents per (coin, dir) from the
 * watched epoch's `count` (`holdDecision`), migrations from `notBefore`. Every release is scheduled individually
 * with its own 0–20 s jitter — never as one burst — and re-checked when it fires. Claims are never held (the
 * protocol parser refuses `hold` on them). A held proof is deleted on submission, on drop, or after 14 days; the
 * status of a finished ticket is kept in memory only, for a day.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hex, HeldStatusJson, Hold } from "./protocol.js";
import { holdDecision, notBeforeDecision, releaseJitterMs, type HoldDecision, type HoldEpochState } from "./policy.js";

export interface HeldRecord {
  ticket: string;
  kind: "intent" | "v1migrate";
  /** the request body exactly as received (re-parsed and re-checked on release) */
  body: unknown;
  /** decimal nullifiers the request spends */
  nullifiers: string[];
  /** unix seconds */
  createdAt: number;
  hold?: Hold;
  coin?: Hex;
  dir?: number;
  notBefore?: number;
}

// ------------------------------------------------------------------------------------------------- encryption

export class HeldCipher {
  private readonly key: Buffer;
  constructor(keyHex: string) {
    const k = keyHex.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("RELAYER_HELD_KEY must be 32 bytes of hex");
    this.key = Buffer.from(k, "hex");
  }
  /** iv (12) | tag (16) | ciphertext */
  seal(ticket: string, plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(ticket, "utf8"));
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  open(ticket: string, blob: Buffer): string {
    if (blob.length < 28) throw new Error("held blob too short");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(ticket, "utf8"));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
  }
}

const TICKET = /^[0-9a-f]{32}$/;
export const newTicket = (): string => crypto.randomBytes(16).toString("hex");
export const isTicket = (t: string): boolean => TICKET.test(t);

/** One encrypted file per held request under `dir` (mode 0600). `dir` null = memory only (tests). */
export class HeldStore {
  private readonly mem = new Map<string, Buffer>();
  constructor(
    private readonly dir: string | null,
    private readonly cipher: HeldCipher,
  ) {
    if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  put(rec: HeldRecord) {
    const blob = this.cipher.seal(rec.ticket, JSON.stringify(rec));
    if (!this.dir) {
      this.mem.set(rec.ticket, blob);
      return;
    }
    const f = path.join(this.dir, `${rec.ticket}.bin`);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, f);
  }
  delete(ticket: string) {
    if (!isTicket(ticket)) return;
    this.mem.delete(ticket);
    if (this.dir) fs.rmSync(path.join(this.dir, `${ticket}.bin`), { force: true });
  }
  /** Raw stored bytes (tests: nothing readable at rest). */
  raw(ticket: string): Buffer | undefined {
    if (!this.dir) return this.mem.get(ticket);
    const f = path.join(this.dir, `${ticket}.bin`);
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }
  /** Every record that decrypts; unreadable files are counted and left alone (never printed). */
  load(): { records: HeldRecord[]; unreadable: number } {
    const records: HeldRecord[] = [];
    let unreadable = 0;
    const entries: [string, Buffer][] = this.dir
      ? fs
          .readdirSync(this.dir)
          .filter((f) => f.endsWith(".bin") && isTicket(f.slice(0, -4)))
          .map((f) => [f.slice(0, -4), fs.readFileSync(path.join(this.dir!, f))])
      : [...this.mem.entries()];
    for (const [ticket, blob] of entries) {
      try {
        const rec = JSON.parse(this.cipher.open(ticket, blob)) as HeldRecord;
        if (rec.ticket !== ticket) throw new Error("ticket mismatch");
        records.push(rec);
      } catch {
        unreadable++;
      }
    }
    return { records, unreadable };
  }
}

// ------------------------------------------------------------------------------------------------- lifecycle

export type SubmitOutcome = { ok: true; hash: Hex } | { ok: false; error: string };

export interface HeldDeps {
  store: HeldStore;
  /** chain time and the watched epoch of each (coin, dir) key `${coin}:${dir}` (lower-case coin) */
  readStates(keys: readonly { coin: Hex; dir: number }[]): Promise<{ now: number; states: Map<string, HoldEpochState> }>;
  /** re-parse, re-check and send the stored request (the server's normal path, without holding) */
  submit(rec: HeldRecord): Promise<SubmitOutcome>;
  /** setTimeout by default; tests pass a fake */
  schedule?: (fn: () => void, ms: number) => void;
  rng?: () => number;
  nowSec?: () => number;
}

export const stateKey = (coin: string, dir: number): string => `${coin.toLowerCase()}:${dir}`;

interface Live {
  rec: HeldRecord;
  releasing: boolean;
  count?: number;
  opensAt?: number;
}
interface Done {
  status: "submitted" | "dropped";
  hash?: Hex;
  reason?: string;
  at: number;
}

const TOMBSTONE_SEC = 86_400;

/** Uniform in [0, 1) from node:crypto: an observer of many release times cannot model Math.random's state. */
export const cryptoRandom = (): number => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

export class HeldManager {
  private readonly live = new Map<string, Live>();
  private readonly done = new Map<string, Done>();
  private readonly nullifiers = new Set<string>();
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly rng: () => number;
  private readonly nowSec: () => number;

  constructor(private readonly deps: HeldDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
    this.rng = deps.rng ?? cryptoRandom; // release jitter from a CSPRNG (implementation review K4)
    this.nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Restore held requests from disk after a restart; returns how many were unreadable. */
  restore(): { restored: number; unreadable: number } {
    const { records, unreadable } = this.deps.store.load();
    for (const rec of records) this.index(rec);
    return { restored: records.length, unreadable };
  }

  private index(rec: HeldRecord) {
    this.live.set(rec.ticket, { rec, releasing: false });
    for (const n of rec.nullifiers) this.nullifiers.add(n);
  }

  /** True when a held request already spends this nullifier (decimal). */
  holdsNullifier(n: bigint | string): boolean {
    return this.nullifiers.has(n.toString());
  }

  /** Store a new held request; refuses a second one spending the same note. */
  add(rec: Omit<HeldRecord, "ticket" | "createdAt">): { ok: true; ticket: string } | { ok: false; error: string } {
    if (rec.nullifiers.some((n) => this.nullifiers.has(n))) return { ok: false, error: "this note is already held for release" };
    const full: HeldRecord = { ...rec, ticket: newTicket(), createdAt: this.nowSec() };
    this.deps.store.put(full);
    this.index(full);
    return { ok: true, ticket: full.ticket };
  }

  status(ticket: string): HeldStatusJson | undefined {
    const l = this.live.get(ticket);
    if (l) {
      const s: HeldStatusJson = { status: "held" };
      if (l.count !== undefined) s.count = l.count;
      if (l.opensAt !== undefined) s.opensAt = l.opensAt;
      return s;
    }
    const d = this.done.get(ticket);
    if (!d) return undefined;
    const s: HeldStatusJson = { status: d.status };
    if (d.hash) s.hash = d.hash;
    if (d.reason) s.reason = d.reason;
    return s;
  }

  get size(): number {
    return this.live.size;
  }

  private finish(ticket: string, d: Omit<Done, "at">) {
    const l = this.live.get(ticket);
    if (!l) return;
    this.live.delete(ticket);
    for (const n of l.rec.nullifiers) this.nullifiers.delete(n);
    this.deps.store.delete(ticket);
    this.done.set(ticket, { ...d, at: this.nowSec() });
  }

  private decide(l: Live, now: number, states: Map<string, HoldEpochState>): HoldDecision {
    const r = l.rec;
    if (r.kind === "v1migrate") return notBeforeDecision(r.notBefore ?? 0, now, r.createdAt);
    const st = states.get(stateKey(r.coin!, r.dir!));
    if (!st) return { action: "wait", count: 0 };
    return holdDecision(r.hold!, st, now, r.createdAt);
  }

  private keysOf(ls: readonly Live[]): { coin: Hex; dir: number }[] {
    const seen = new Map<string, { coin: Hex; dir: number }>();
    for (const l of ls) if (l.rec.kind === "intent") seen.set(stateKey(l.rec.coin!, l.rec.dir!), { coin: l.rec.coin!, dir: l.rec.dir! });
    return [...seen.values()];
  }

  /** One poll: read the watched epochs once, then release (jittered, individually), wait or drop each request. */
  async tick(): Promise<{ released: number; dropped: number; waiting: number }> {
    const now0 = this.nowSec();
    for (const [t, d] of this.done) if (d.at + TOMBSTONE_SEC < now0) this.done.delete(t);
    const idle = [...this.live.values()].filter((l) => !l.releasing);
    if (idle.length === 0) return { released: 0, dropped: 0, waiting: 0 };
    const { now, states } = await this.deps.readStates(this.keysOf(idle));
    let released = 0;
    let dropped = 0;
    let waiting = 0;
    for (const l of idle) {
      const d = this.decide(l, now, states);
      if (d.action === "release") {
        l.releasing = true;
        released++;
        this.schedule(() => void this.fire(l.rec.ticket), releaseJitterMs(this.rng));
      } else if (d.action === "drop") {
        dropped++;
        this.finish(l.rec.ticket, { status: "dropped", reason: d.reason });
      } else {
        waiting++;
        l.count = l.rec.kind === "intent" ? d.count : undefined;
        l.opensAt = d.opensAt;
      }
    }
    return { released, dropped, waiting };
  }

  /** A jittered release fires: re-check the condition with fresh state, then submit through the normal path. */
  async fire(ticket: string): Promise<void> {
    const l = this.live.get(ticket);
    if (!l) return;
    try {
      const { now, states } = await this.deps.readStates(this.keysOf([l]));
      const d = this.decide(l, now, states);
      if (d.action === "wait") {
        l.releasing = false; // e.g. the epoch opened during the jitter: watch the next one
        return;
      }
      if (d.action === "drop") {
        this.finish(ticket, { status: "dropped", reason: d.reason });
        return;
      }
      const r = await this.deps.submit(l.rec);
      if (r.ok) this.finish(ticket, { status: "submitted", hash: r.hash });
      else this.finish(ticket, { status: "dropped", reason: r.error });
    } catch (e) {
      // chain unreachable: keep it held, the next tick retries
      l.releasing = false;
      void e;
    }
  }
}
