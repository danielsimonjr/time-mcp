import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for record validation
// ---------------------------------------------------------------------------

const TimerRecordSchema = z.object({
  label: z.string().nullable(),
  started_at: z.string().min(1),
  expires_at: z.string().min(1),
  cancelled_at: z.string().nullable(),
  notified_at: z.string().nullable().optional(),
});

const StopwatchRecordSchema = z.object({
  label: z.string().nullable(),
  started_at: z.string().min(1),
  stopped_at: z.string().nullable(),
});

const AlarmRecordSchema = z.object({
  label: z.string().nullable(),
  fires_at: z.string().min(1),
  cancelled_at: z.string().nullable(),
  notified_at: z.string().nullable().optional(),
});

export type TimerRecord = z.infer<typeof TimerRecordSchema>;
export type StopwatchRecord = z.infer<typeof StopwatchRecordSchema>;
export type AlarmRecord = z.infer<typeof AlarmRecordSchema>;

export interface State {
  timers: Record<string, TimerRecord>;
  stopwatches: Record<string, StopwatchRecord>;
  alarms: Record<string, AlarmRecord>;
}

const DEFAULT_STATE_KEYS: ReadonlyArray<keyof State> = ["timers", "stopwatches", "alarms"];

function defaultState(): State {
  return { timers: {}, stopwatches: {}, alarms: {} };
}

function parseRecords<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  kind: string,
): Record<string, T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, T> = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    const result = schema.safeParse(val);
    if (result.success) {
      out[id] = result.data;
    } else {
      process.stderr.write(
        `time-mcp: dropped malformed ${kind} record '${id}': ${result.error.message}\n`,
      );
    }
  }
  return out;
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
    const p = parsed as Record<string, unknown>;
    out.timers = parseRecords(p[DEFAULT_STATE_KEYS[0]], TimerRecordSchema, "timer");
    out.stopwatches = parseRecords(p[DEFAULT_STATE_KEYS[1]], StopwatchRecordSchema, "stopwatch");
    out.alarms = parseRecords(p[DEFAULT_STATE_KEYS[2]], AlarmRecordSchema, "alarm");
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
