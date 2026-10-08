import fs from "node:fs";
import path from "node:path";

/** Persistent keeper state (SNAPSHOT_DIR/state.json). Survives restarts so a scheduled snapshot keeps its moment. */
export interface KeeperState {
  version: 1;
  /** coin (checksummed) → unix seconds at which the snapshot fires */
  scheduled: Record<string, { at: number; scheduledAt: number; potAtSchedule: string }>;
  /** last known tx per command, for the operator's convenience */
  lastTx: Record<string, { hash: string; at: number }>;
}

export function emptyState(): KeeperState {
  return { version: 1, scheduled: {}, lastTx: {} };
}

export function statePath(snapshotDir: string): string {
  return path.join(snapshotDir, "state.json");
}

/** A missing or unreadable state file starts empty. */
export function loadState(snapshotDir: string): KeeperState {
  const raw = readJson<Partial<KeeperState>>(statePath(snapshotDir));
  return raw ? { version: 1, scheduled: raw.scheduled ?? {}, lastTx: raw.lastTx ?? {} } : emptyState();
}

export function saveState(snapshotDir: string, s: KeeperState): void {
  writeJsonAtomic(statePath(snapshotDir), s);
}

/** Write JSON via a temp file + rename so a crash never leaves a half-written file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
