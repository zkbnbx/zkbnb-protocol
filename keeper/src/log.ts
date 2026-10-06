type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

function fmt(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Error) return v.message;
  if (typeof v === "object" && v !== null) {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  }
  return String(v);
}

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const ts = new Date().toISOString();
  const tail = extra ? " " + Object.entries(extra).map(([k, v]) => `${k}=${fmt(v)}`).join(" ") : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
