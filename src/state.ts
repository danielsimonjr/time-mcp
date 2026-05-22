import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TimerRecord {
  label: string | null;
  started_at: string;
  expires_at: string;
  cancelled_at: string | null;
  notified_at?: string | null;
}

export interface StopwatchRecord {
  label: string | null;
  started_at: string;
  stopped_at: string | null;
}

export interface AlarmRecord {
  label: string | null;
  fires_at: string;
  cancelled_at: string | null;
  notified_at?: string | null;
}

export interface State {
  timers: Record<string, TimerRecord>;
  stopwatches: Record<string, StopwatchRecord>;
  alarms: Record<string, AlarmRecord>;
}

const DEFAULT_STATE_KEYS: ReadonlyArray<keyof State> = ["timers", "stopwatches", "alarms"];

function defaultState(): State {
  return { timers: {}, stopwatches: {}, alarms: {} };
}

function assignKey<K extends keyof State>(s: State, k: K, v: State[K]): void {
  s[k] = v;
}

function stateDir(): string {
  return process.env.TIME_MCP_STATE_DIR ?? join(homedir(), ".time-mcp");
}

function stateFile(): string {
  return join(stateDir(), "state.json");
}

export function makeId(): string {
  return randomBytes(6).toString("base64url");
}

export async function loadState(): Promise<State> {
  const path = stateFile();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return defaultState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backup = `${path}.corrupted.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(path, backup);
    } catch {
      // best effort — if the rename fails we still log + continue
    }
    process.stderr.write(`time-mcp: state.json failed to parse, moved to ${backup}; starting from empty state (${(err as Error).message})\n`);
    return defaultState();
  }
  const out = defaultState();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of DEFAULT_STATE_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        assignKey(out, key, v as State[typeof key]);
      }
    }
  }
  return out;
}

const REPLACE_RETRIES = 3;
const REPLACE_BACKOFF_MS = 10;

export async function saveState(state: State): Promise<void> {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  // Trim to known keys before serializing — drops unknown top-level fields.
  const trimmed: State = {
    timers: state.timers,
    stopwatches: state.stopwatches,
    alarms: state.alarms,
  };
  const tmp = join(dir, `.state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2), { encoding: "utf8" });
  const target = stateFile();
  for (let attempt = 0; attempt < REPLACE_RETRIES; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < REPLACE_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, REPLACE_BACKOFF_MS * 2 ** attempt));
        continue;
      }
      process.stderr.write(`time-mcp: save_state failed: ${(err as Error).message}\n`);
      try { renameSync(tmp, tmp + ".failed"); } catch { /* cleanup best effort */ }
      throw err;
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

export async function withState<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const s = await loadState();
    const result = await fn(s);
    await saveState(s);
    return result;
  });
  queue = next.catch(() => undefined); // don't poison the queue
  return next as Promise<T>;
}
