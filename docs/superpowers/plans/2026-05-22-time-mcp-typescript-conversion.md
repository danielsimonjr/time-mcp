# time-mcp TypeScript Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `time-mcp` MCP server from Python (FastMCP) to TypeScript on `@modelcontextprotocol/sdk`, with the five design fixes from the spec folded in. Keep Python source until live-verified; then retire.

**Architecture:** Six source modules — `state.ts` (persistence + mutex), `parsers.ts` (duration + alarm time), `time.ts` (timezone + DST), `tools.ts` (14 TOOLS + HANDLERS dispatch), `index.ts` (MCP wiring), `notify-hook.ts` (separate CLI entry). Strict JSON-output parity with Python for valid sequential calls; one observable behavior change in `stopwatch_stop` (now idempotent). State at `~/.time-mcp/state.json` is read in-place so existing timers/alarms survive cutover.

**Tech Stack:** Node 24, TypeScript ES2022 target Node16 modules, `@modelcontextprotocol/sdk` v1.x, `luxon` v3, `chrono-node` v2, `zod` v4 (handler-side arg validation), vitest v4, plain `tsc` build.

**Spec:** `docs/superpowers/specs/2026-05-22-time-mcp-typescript-conversion-design.md`

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Modify: `.gitignore` (if exists) to add `dist/`, `node_modules/`, `*.tsbuildinfo`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "time-mcp",
  "version": "0.2.0",
  "description": "MCP server for current time, timers, stopwatches, and alarms",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "time-mcp": "dist/index.js",
    "time-mcp-notify-hook": "dist/notify-hook.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "chrono-node": "^2.7.0",
    "luxon": "^3.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/luxon": "^3.4.0",
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.0"
  },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["tests/**", "dist/**", "node_modules/**"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Append to .gitignore (create if missing)**

```
node_modules/
dist/
*.tsbuildinfo
.vitest/
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 6: Verify typecheck + test run with empty tree**

Run: `npm run typecheck` → expected: succeeds (no .ts files in src/ yet — empty project compiles fine).
Run: `npx vitest run` → expected: "No test files found" or `0 tests`. Exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore(ts): scaffold TypeScript project for time-mcp conversion"
```

---

## Task 2: state.ts — persistence, mutex, corrupted-state recovery

**Files:**
- Create: `src/state.ts`
- Create: `tests/state.test.ts`

**Spec refs:** §4 (state model), §9.1 (mutex), §9.3 (corruption recovery), §9.5 (stderr logging).

- [ ] **Step 1: Write the failing tests in `tests/state.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let prevEnv: string | undefined;
let stderr: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "time-mcp-state-"));
  prevEnv = process.env.TIME_MCP_STATE_DIR;
  process.env.TIME_MCP_STATE_DIR = tmp;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TIME_MCP_STATE_DIR;
  else process.env.TIME_MCP_STATE_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadState / saveState", () => {
  it("returns DEFAULT_STATE when state.json is missing", async () => {
    const { loadState } = await import("../src/state.js");
    const s = await loadState();
    expect(s).toEqual({ timers: {}, stopwatches: {}, alarms: {} });
  });

  it("round-trips state through saveState/loadState", async () => {
    const { loadState, saveState } = await import("../src/state.js");
    await saveState({
      timers: { aBc12345: { label: "deploy", started_at: "2026-05-22T10:00:00.000Z", expires_at: "2026-05-22T10:05:00.000Z", cancelled_at: null } },
      stopwatches: {},
      alarms: {},
    });
    const s = await loadState();
    expect(s.timers.aBc12345.label).toBe("deploy");
  });

  it("fills missing top-level keys with defaults (forward compat)", async () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ timers: { x: { label: "a", started_at: "t", expires_at: "t", cancelled_at: null } } }));
    const { loadState } = await import("../src/state.js");
    const s = await loadState();
    expect(s.stopwatches).toEqual({});
    expect(s.alarms).toEqual({});
  });

  it("drops unknown top-level keys on save (forward compat)", async () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ timers: {}, stopwatches: {}, alarms: {}, futureField: { hi: 1 } }));
    const { loadState, saveState } = await import("../src/state.js");
    const s = await loadState();
    await saveState(s);
    const onDisk = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8"));
    expect("futureField" in onDisk).toBe(false);
  });

  it("uses 2-space indent and preserves non-ASCII labels", async () => {
    const { saveState } = await import("../src/state.js");
    await saveState({
      timers: { id1: { label: "déjà 🔔", started_at: "t", expires_at: "t", cancelled_at: null } },
      stopwatches: {}, alarms: {},
    });
    const raw = readFileSync(join(tmp, "state.json"), "utf8");
    expect(raw).toContain('"label": "déjà 🔔"');  // no ASCII-escaping
    expect(raw).toContain("  \"timers\": {");      // 2-space indent
  });

  it("backs up corrupted state.json and logs to stderr", async () => {
    writeFileSync(join(tmp, "state.json"), "{not valid json");
    const { loadState } = await import("../src/state.js");
    const s = await loadState();
    expect(s).toEqual({ timers: {}, stopwatches: {}, alarms: {} });
    const backup = readdirSync(tmp).find((f) => f.startsWith("state.json.corrupted."));
    expect(backup).toBeDefined();
    expect(readFileSync(join(tmp, backup!), "utf8")).toBe("{not valid json");
    expect(stderr.join("")).toMatch(/state\.json failed to parse/);
  });
});

describe("makeId", () => {
  it("returns an 8-char base64url string", async () => {
    const { makeId } = await import("../src/state.js");
    const id = makeId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("returns different IDs on consecutive calls", async () => {
    const { makeId } = await import("../src/state.js");
    expect(makeId()).not.toBe(makeId());
  });
});

describe("withState (mutex)", () => {
  it("serializes concurrent mutations — no lost updates", async () => {
    const { withState, saveState } = await import("../src/state.js");
    await saveState({ timers: {}, stopwatches: {}, alarms: {} });
    // Race 50 concurrent additions; each adds one timer keyed by index.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withState(async (s) => {
          // Yield a tick so naive non-locked impl would race.
          await new Promise((r) => setImmediate(r));
          s.timers[`id${i.toString().padStart(2, "0")}`] = {
            label: `t${i}`, started_at: "x", expires_at: "x", cancelled_at: null,
          };
        }),
      ),
    );
    const finalRaw = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8"));
    expect(Object.keys(finalRaw.timers).length).toBe(50);
  });

  it("does not poison the queue when a callback throws", async () => {
    const { withState, saveState } = await import("../src/state.js");
    await saveState({ timers: {}, stopwatches: {}, alarms: {} });
    await expect(withState(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    // Subsequent call must still work.
    await expect(withState(async (s) => { s.timers.ok = { label: "ok", started_at: "x", expires_at: "x", cancelled_at: null }; return "done"; })).resolves.toBe("done");
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail**

Run: `npx vitest run tests/state.test.ts`
Expected: All tests FAIL with "Cannot find module ../src/state.js" (or similar).

- [ ] **Step 3: Implement `src/state.ts`**

```typescript
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
        out[key] = v as State[typeof key];
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
  const trimmed: State = defaultState();
  for (const key of DEFAULT_STATE_KEYS) {
    trimmed[key] = state[key] as State[typeof key];
  }
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
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/state.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat(ts): state persistence with mutex and corrupted-file recovery"
```

---

## Task 3: parsers.ts — parseDuration + parseAlarmTime

**Files:**
- Create: `src/parsers.ts`
- Create: `tests/parsers.test.ts`

**Spec refs:** §5 (NL parsing), §8 (error strings).

- [ ] **Step 1: Write failing tests in `tests/parsers.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseDuration, parseAlarmTime } from "../src/parsers.js";
import { DateTime } from "luxon";

describe("parseDuration", () => {
  it("parses bare integers as seconds", () => {
    expect(parseDuration("30")).toBe(30);
    expect(parseDuration("  0  ")).toBe(0);
  });
  it("parses d/h/m/s combinations", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("1d2h3m4s")).toBe(86400 + 7200 + 180 + 4);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("0s")).toBe(0);
  });
  it("rejects empty input", () => {
    expect(() => parseDuration("")).toThrow("Duration is empty");
    expect(() => parseDuration("   ")).toThrow("Duration is empty");
  });
  it("rejects malformed durations with the exact Python wording", () => {
    expect(() => parseDuration("xyz")).toThrow("Malformed duration 'xyz'; expected forms like '5m', '1h30m', '90s', '2d'");
    expect(() => parseDuration("1m2h")).toThrow(/Malformed duration '1m2h'/);  // out-of-order
    expect(() => parseDuration("1.5h")).toThrow(/Malformed duration '1\.5h'/);
  });
});

describe("parseAlarmTime — strict path", () => {
  it("parses ISO 8601 with Z", () => {
    const dt = parseAlarmTime("2030-12-31T23:59:00Z");
    expect(dt.toUTC().toISO()).toContain("2030-12-31T23:59:00");
  });
  it("parses space-separated naive timestamps, defaulting to UTC", () => {
    const dt = parseAlarmTime("2030-06-15 14:30:00");
    expect(dt.zoneName).toBe("UTC");
    expect(dt.hour).toBe(14);
  });
  it("parses space-separated naive timestamps in the given timezone", () => {
    const dt = parseAlarmTime("2030-06-15 14:30:00", "America/New_York");
    expect(dt.zoneName).toBe("America/New_York");
    expect(dt.hour).toBe(14);
  });
  it("parses 'in 4h' relative form", () => {
    const before = DateTime.now();
    const dt = parseAlarmTime("in 4h");
    const deltaHours = dt.diff(before, "hours").hours;
    expect(deltaHours).toBeGreaterThan(3.99);
    expect(deltaHours).toBeLessThan(4.01);
  });
  it("parses 'in 1d2h30m' relative form", () => {
    const before = DateTime.now();
    const dt = parseAlarmTime("in 1d2h30m");
    const deltaSeconds = dt.diff(before, "seconds").seconds;
    expect(deltaSeconds).toBeGreaterThan(86400 + 9000 - 2);
    expect(deltaSeconds).toBeLessThan(86400 + 9000 + 2);
  });
  it("parses 'today at HH:MM'", () => {
    const dt = parseAlarmTime("today at 23:59", "America/New_York");
    expect(dt.zoneName).toBe("America/New_York");
    expect(dt.hour).toBe(23);
    expect(dt.minute).toBe(59);
  });
  it("parses 'tomorrow at HH:MM'", () => {
    const today = DateTime.now().setZone("America/New_York");
    const dt = parseAlarmTime("tomorrow at 09:00", "America/New_York");
    expect(dt.day).toBe(today.plus({ days: 1 }).day);
    expect(dt.hour).toBe(9);
  });
});

describe("parseAlarmTime — chrono fallback", () => {
  it("parses 'next Tuesday at 3pm' to some future timestamp", () => {
    const now = DateTime.now();
    const dt = parseAlarmTime("next Tuesday at 3pm");
    expect(dt.toMillis()).toBeGreaterThan(now.toMillis());
    expect(dt.hour).toBe(15);
  });
  it("biases forward (PREFER_DATES_FROM future)", () => {
    // "9am" alone — must be a future 9am, not a past 9am today
    const now = DateTime.now();
    const dt = parseAlarmTime("9am");
    expect(dt.toMillis()).toBeGreaterThan(now.toMillis());
  });
  it("throws on unparseable input with Python's exact wording", () => {
    expect(() => parseAlarmTime("not a real time at all")).toThrow("Could not parse alarm time: 'not a real time at all'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parsers.test.ts`
Expected: All FAIL — module not found.

- [ ] **Step 3: Implement `src/parsers.ts`**

```typescript
import * as chrono from "chrono-node";
import { DateTime } from "luxon";

const DURATION_RE = /^\s*(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$/;
const BARE_NUMBER_RE = /^\s*\d+\s*$/;
const RELATIVE_IN_RE = /^\s*in\s+(.+?)\s*$/i;
const TODAY_AT_RE = /^\s*today\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i;
const TOMORROW_AT_RE = /^\s*tomorrow\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i;
// Accepts "YYYY-MM-DD HH:MM[:SS][Z|+HH:MM]" or "YYYY-MM-DDTHH:MM[:SS][Z|+HH:MM]"
const ISO_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?\s*$/;

export function parseDuration(s: string): number {
  if (!s || !s.trim()) throw new Error("Duration is empty");
  if (BARE_NUMBER_RE.test(s)) return parseInt(s.trim(), 10);
  const m = DURATION_RE.exec(s);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) {
    throw new Error(`Malformed duration '${s}'; expected forms like '5m', '1h30m', '90s', '2d'`);
  }
  const [, d, h, mi, sec] = m;
  return (+(d ?? 0)) * 86400 + (+(h ?? 0)) * 3600 + (+(mi ?? 0)) * 60 + (+(sec ?? 0));
}

function strictParse(s: string, tzName: string): DateTime | null {
  // Try ISO
  const iso = ISO_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, offset] = iso;
    const args = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: sec ? +sec : 0 };
    if (offset) {
      // Has explicit zone/offset — let Luxon parse it as ISO directly
      const dt = DateTime.fromISO(s.trim().replace(" ", "T"), { setZone: true });
      return dt.isValid ? dt : null;
    }
    // Naive — interpret in tzName (default UTC)
    return DateTime.fromObject(args, { zone: tzName });
  }
  // Try "in <duration>"
  const rel = RELATIVE_IN_RE.exec(s);
  if (rel) {
    try {
      const secs = parseDuration(rel[1]);
      return DateTime.now().setZone(tzName).plus({ seconds: secs });
    } catch {
      return null;
    }
  }
  // Try "today at HH:MM[:SS]"
  const today = TODAY_AT_RE.exec(s);
  if (today) {
    const [, h, mi, sec] = today;
    const now = DateTime.now().setZone(tzName);
    return now.set({ hour: +h, minute: +mi, second: sec ? +sec : 0, millisecond: 0 });
  }
  // Try "tomorrow at HH:MM[:SS]"
  const tom = TOMORROW_AT_RE.exec(s);
  if (tom) {
    const [, h, mi, sec] = tom;
    const now = DateTime.now().setZone(tzName);
    return now.plus({ days: 1 }).set({ hour: +h, minute: +mi, second: sec ? +sec : 0, millisecond: 0 });
  }
  return null;
}

export function parseAlarmTime(s: string, tzName?: string): DateTime {
  const zone = tzName || "UTC";
  const strict = strictParse(s, zone);
  if (strict && strict.isValid) return strict;
  // Fallback: chrono-node with forwardDate
  const results = chrono.parse(s, new Date(), { forwardDate: true });
  if (results.length > 0) {
    const date = results[0].start.date();
    // chrono returns a JS Date in the system zone — convert to luxon, then to target zone
    const dt = DateTime.fromJSDate(date).setZone(zone);
    if (dt.isValid) return dt;
  }
  throw new Error(`Could not parse alarm time: '${s}'`);
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/parsers.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers.ts tests/parsers.test.ts
git commit -m "feat(ts): duration and alarm-time parsers (strict + chrono fallback)"
```

---

## Task 4: time.ts — get_current_time + convert_time helpers

**Files:**
- Create: `src/time.ts`
- Create: `tests/time.test.ts`

**Spec refs:** §6 (timezone handling), §8 (error strings).

- [ ] **Step 1: Write failing tests in `tests/time.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { getCurrentTime, convertTime } from "../src/time.js";

describe("getCurrentTime", () => {
  it("returns ok with the asked timezone", () => {
    const r = JSON.parse(getCurrentTime("America/New_York"));
    expect(r.status).toBe("ok");
    expect(r.timezone).toBe("America/New_York");
    expect(r.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(typeof r.is_dst).toBe("boolean");
    expect(r.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
  it("falls back to system or UTC when timezone is null/undefined", () => {
    const r = JSON.parse(getCurrentTime(null));
    expect(r.status).toBe("ok");
    expect(typeof r.timezone).toBe("string");
    expect(r.timezone.length).toBeGreaterThan(0);
  });
  it("returns Python's exact error wording on unknown IANA name", () => {
    const r = JSON.parse(getCurrentTime("Bogus/Zone"));
    expect(r).toEqual({ status: "error", error: "Unknown IANA timezone: 'Bogus/Zone'" });
  });
});

describe("convertTime", () => {
  it("converts UTC noon to America/New_York morning", () => {
    const r = JSON.parse(convertTime("UTC", "12:00", "America/New_York"));
    expect(r.status).toBe("ok");
    expect(r.source.timezone).toBe("UTC");
    expect(r.target.timezone).toBe("America/New_York");
    expect(r.source.time).toBe("12:00:00");
    // NY offset is -4 or -5 depending on DST
    expect([-4, -5]).toContain(r.offset_hours);
  });
  it("returns error on unknown source timezone", () => {
    const r = JSON.parse(convertTime("Bogus/Zone", "12:00", "UTC"));
    expect(r).toEqual({ status: "error", error: "Unknown source timezone: 'Bogus/Zone'" });
  });
  it("returns error on unknown target timezone", () => {
    const r = JSON.parse(convertTime("UTC", "12:00", "Bogus/Zone"));
    expect(r).toEqual({ status: "error", error: "Unknown target timezone: 'Bogus/Zone'" });
  });
  it("returns error on malformed HH:MM", () => {
    const r = JSON.parse(convertTime("UTC", "25:99", "America/New_York"));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/Malformed time '25:99'/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/time.test.ts`
Expected: All FAIL.

- [ ] **Step 3: Implement `src/time.ts`**

```typescript
import { DateTime, IANAZone } from "luxon";

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function tzExists(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

function systemZone(): string {
  const z = DateTime.local().zoneName;
  return z && tzExists(z) ? z : "UTC";
}

function snapshot(dt: DateTime): { timezone: string; datetime: string; time: string; is_dst: boolean } {
  return {
    timezone: dt.zoneName ?? "UTC",
    datetime: dt.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? "",
    time: dt.toFormat("HH:mm:ss"),
    is_dst: dt.isInDST,
  };
}

export function getCurrentTime(tzName: string | null | undefined): string {
  let zone: string;
  if (tzName) {
    if (!tzExists(tzName)) {
      return JSON.stringify({ status: "error", error: `Unknown IANA timezone: '${tzName}'` });
    }
    zone = tzName;
  } else {
    zone = systemZone();
  }
  const dt = DateTime.now().setZone(zone);
  return JSON.stringify({ status: "ok", ...snapshot(dt) });
}

export function convertTime(sourceTz: string, time: string, targetTz: string): string {
  if (!tzExists(sourceTz)) {
    return JSON.stringify({ status: "error", error: `Unknown source timezone: '${sourceTz}'` });
  }
  if (!tzExists(targetTz)) {
    return JSON.stringify({ status: "error", error: `Unknown target timezone: '${targetTz}'` });
  }
  const m = HHMM_RE.exec(time);
  if (!m) {
    return JSON.stringify({ status: "error", error: `Malformed time '${time}'; expected 24-hour HH:MM (e.g., '14:30')` });
  }
  const hour = +m[1];
  const minute = +m[2];
  if (hour > 23 || minute > 59) {
    return JSON.stringify({ status: "error", error: `Malformed time '${time}'; expected 24-hour HH:MM (e.g., '14:30')` });
  }
  const today = DateTime.now().setZone(sourceTz);
  const sourceDt = DateTime.fromObject(
    { year: today.year, month: today.month, day: today.day, hour, minute, second: 0 },
    { zone: sourceTz },
  );
  if (!sourceDt.isValid) {
    return JSON.stringify({
      status: "error",
      error: `Time '${time}' does not exist in ${sourceTz} on ${today.toFormat("yyyy-LL-dd")} (DST spring-forward gap)`,
    });
  }
  // Round-trip detection (Luxon doesn't always flag DST gaps as invalid)
  const roundTrip = sourceDt.toUTC().setZone(sourceTz);
  if (roundTrip.hour !== hour || roundTrip.minute !== minute) {
    return JSON.stringify({
      status: "error",
      error: `Time '${time}' does not exist in ${sourceTz} on ${today.toFormat("yyyy-LL-dd")} (DST spring-forward gap)`,
    });
  }
  const targetDt = sourceDt.setZone(targetTz);
  const offsetHours = (targetDt.offset - sourceDt.offset) / 60;
  return JSON.stringify({
    status: "ok",
    source: snapshot(sourceDt),
    target: snapshot(targetDt),
    offset_hours: offsetHours,
  });
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/time.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/time.ts tests/time.test.ts
git commit -m "feat(ts): get_current_time and convert_time helpers (Luxon)"
```

---

## Task 5: tools.ts — TOOLS array, types, smoke test

**Files:**
- Create: `src/tools.ts` (definitions only; handlers added in Tasks 6-8)
- Create: `tests/tools-defs.test.ts`
- Create: `tests/smoke.test.ts`

**Spec refs:** §9.4 (annotations table).

- [ ] **Step 1: Write failing tests `tests/tools-defs.test.ts` and `tests/smoke.test.ts`**

`tests/tools-defs.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";

const EXPECTED_NAMES = [
  "get_current_time", "convert_time",
  "timer_start", "timer_check", "timer_list", "timer_cancel",
  "stopwatch_start", "stopwatch_check", "stopwatch_stop", "stopwatch_list",
  "alarm_set", "alarm_check", "alarm_list", "alarm_cancel",
].sort();

const READ_ONLY = new Set([
  "get_current_time", "convert_time",
  "timer_check", "timer_list",
  "stopwatch_check", "stopwatch_list",
  "alarm_check", "alarm_list",
]);

describe("TOOLS", () => {
  it("has exactly 14 tools with the expected names", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(EXPECTED_NAMES);
  });
  it("every tool has an annotations object", () => {
    for (const t of TOOLS) {
      expect(t.annotations).toBeDefined();
    }
  });
  it("readOnlyHint matches the spec §9.4 table exactly", () => {
    for (const t of TOOLS) {
      const expectReadOnly = READ_ONLY.has(t.name);
      expect(t.annotations?.readOnlyHint ?? false).toBe(expectReadOnly);
    }
  });
  it("no tool sets destructiveHint: true (cancellations are soft)", () => {
    for (const t of TOOLS) {
      expect(t.annotations?.destructiveHint ?? false).toBe(false);
    }
  });
  it("every tool has a non-empty description", () => {
    for (const t of TOOLS) {
      expect(t.description).toBeDefined();
      expect((t.description as string).length).toBeGreaterThan(10);
    }
  });
  it("every tool has an inputSchema", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });
});
```

`tests/smoke.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { TOOLS, HANDLERS } from "../src/tools.js";

describe("TOOLS ↔ HANDLERS symmetry", () => {
  it("every tool name has a handler", () => {
    const toolNames = TOOLS.map((t) => t.name).sort();
    const handlerNames = Object.keys(HANDLERS).sort();
    expect(handlerNames).toEqual(toolNames);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/tools-defs.test.ts tests/smoke.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools.ts` (TOOLS array + empty HANDLERS placeholder)**

```typescript
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (raw: unknown) => Promise<string>;

const TZ_DESC = "IANA timezone name (e.g., 'America/New_York', 'UTC'). Optional — defaults to system local zone, then UTC.";

export const TOOLS: Tool[] = [
  {
    name: "get_current_time",
    description: "Get the current time in a given timezone (or system local if not specified). Returns ISO datetime, HH:MM:SS, and is_dst.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { timezone: { type: "string", description: TZ_DESC } },
      additionalProperties: false,
    },
  },
  {
    name: "convert_time",
    description: "Convert a HH:MM time from one timezone to another, using today's date in the source zone.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        source_timezone: { type: "string", description: "IANA name." },
        time: { type: "string", description: "24-hour HH:MM, e.g. '14:30'." },
        target_timezone: { type: "string", description: "IANA name." },
      },
      required: ["source_timezone", "time", "target_timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "timer_start",
    description: "Start a countdown timer. Duration like '5m', '1h30m', '90s', or '0s'. Returns timer_id (8 chars) for later check/cancel.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        duration: { type: "string", description: "e.g. '5m', '1h30m', '90s', '1d2h3m4s', or a bare integer in seconds." },
        label: { type: "string", description: "Optional human-readable name." },
      },
      required: ["duration"],
      additionalProperties: false,
    },
  },
  {
    name: "timer_check",
    description: "Look up a timer by ID and return its current status (running / expired / cancelled) and remaining seconds.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { timer_id: { type: "string" } },
      required: ["timer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "timer_list",
    description: "List all timers (running, expired, and cancelled).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "timer_cancel",
    description: "Cancel a timer by ID. Idempotent — cancelling an already-cancelled timer returns OK.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { timer_id: { type: "string" } },
      required: ["timer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stopwatch_start",
    description: "Start a count-up stopwatch. Returns stopwatch_id for later check/stop.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", description: "Optional human-readable name." } },
      additionalProperties: false,
    },
  },
  {
    name: "stopwatch_check",
    description: "Look up a stopwatch by ID and return its current status (running / stopped) and elapsed seconds.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { stopwatch_id: { type: "string" } },
      required: ["stopwatch_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stopwatch_stop",
    description: "Stop a stopwatch by ID. Idempotent — stopping an already-stopped stopwatch returns OK with unchanged stopped_at.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { stopwatch_id: { type: "string" } },
      required: ["stopwatch_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stopwatch_list",
    description: "List all stopwatches (running and stopped).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "alarm_set",
    description: "Set an alarm at an absolute or natural-language time ('in 4h', 'tomorrow at 9am', '2030-12-31 23:59:00'). Returns alarm_id.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", description: "Natural language or absolute time." },
        label: { type: "string", description: "Optional human-readable name." },
      },
      required: ["when"],
      additionalProperties: false,
    },
  },
  {
    name: "alarm_check",
    description: "Look up an alarm by ID and return its current status (pending / fired / cancelled) and seconds until fire.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { alarm_id: { type: "string" } },
      required: ["alarm_id"],
      additionalProperties: false,
    },
  },
  {
    name: "alarm_list",
    description: "List all alarms (pending, fired, and cancelled).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "alarm_cancel",
    description: "Cancel an alarm by ID. Idempotent — cancelling an already-cancelled alarm returns OK.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { alarm_id: { type: "string" } },
      required: ["alarm_id"],
      additionalProperties: false,
    },
  },
];

// HANDLERS map — populated incrementally in Tasks 6, 7, 8.
export const HANDLERS: Record<string, ToolHandler> = {};
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/tools-defs.test.ts`
Expected: 6 tests pass.
Run: `npx vitest run tests/smoke.test.ts`
Expected: **smoke test FAILS** — HANDLERS is empty, mismatch with 14 TOOLS. **That's expected at this point.** It will pass after Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-defs.test.ts tests/smoke.test.ts
git commit -m "feat(ts): TOOLS definitions with readOnlyHint/destructiveHint annotations"
```

---

## Task 6: HANDLERS — time + timer handlers

**Files:**
- Modify: `src/tools.ts` (append handlers for `get_current_time`, `convert_time`, `timer_start`, `timer_check`, `timer_list`, `timer_cancel`)
- Create: `tests/handlers-timer.test.ts`

**Spec refs:** §3 (handlers return JSON strings); §9.1 (withState for mutations).

- [ ] **Step 1: Write the failing tests `tests/handlers-timer.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "time-mcp-h-"));
  prevEnv = process.env.TIME_MCP_STATE_DIR;
  process.env.TIME_MCP_STATE_DIR = tmp;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TIME_MCP_STATE_DIR;
  else process.env.TIME_MCP_STATE_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("timer_start / timer_check / timer_list / timer_cancel", () => {
  it("timer_start returns ok with 8-char timer_id, label, duration_seconds, expires_at", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.timer_start({ duration: "5m", label: "deploy" }));
    expect(r.status).toBe("ok");
    expect(r.timer_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(r.label).toBe("deploy");
    expect(r.duration_seconds).toBe(300);
    expect(r.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("timer_start rejects malformed duration with exact wording", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.timer_start({ duration: "xyz" }));
    expect(r).toEqual({ status: "error", error: "Malformed duration 'xyz'; expected forms like '5m', '1h30m', '90s', '2d'" });
  });
  it("timer_check returns running status with remaining_seconds", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.timer_start({ duration: "60s", label: "t" }));
    const check = JSON.parse(await HANDLERS.timer_check({ timer_id: start.timer_id }));
    expect(check.status).toBe("ok");
    expect(check.timer.status).toBe("running");
    expect(check.timer.remaining_seconds).toBeLessThanOrEqual(60);
    expect(check.timer.remaining_seconds).toBeGreaterThan(55);
  });
  it("timer_check returns expired when expires_at is past", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.timer_start({ duration: "0s" }));
    await new Promise((r) => setTimeout(r, 10));
    const check = JSON.parse(await HANDLERS.timer_check({ timer_id: start.timer_id }));
    expect(check.timer.status).toBe("expired");
  });
  it("timer_check returns error on unknown ID", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.timer_check({ timer_id: "no_such_x" }));
    expect(r).toEqual({ status: "error", error: "Timer 'no_such_x' not found" });
  });
  it("timer_cancel is idempotent", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.timer_start({ duration: "60s" }));
    const c1 = JSON.parse(await HANDLERS.timer_cancel({ timer_id: start.timer_id }));
    const c2 = JSON.parse(await HANDLERS.timer_cancel({ timer_id: start.timer_id }));
    expect(c1.status).toBe("ok");
    expect(c2.status).toBe("ok");
    expect(c1.timer.cancelled_at).toBe(c2.timer.cancelled_at);  // first-cancel wins
    expect(c1.timer.status).toBe("cancelled");
  });
  it("timer_list returns count and all timers", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.timer_start({ duration: "60s", label: "a" });
    await HANDLERS.timer_start({ duration: "120s", label: "b" });
    const r = JSON.parse(await HANDLERS.timer_list({}));
    expect(r.status).toBe("ok");
    expect(r.count).toBe(2);
    expect(r.timers.map((t: { label: string }) => t.label).sort()).toEqual(["a", "b"]);
  });
});

describe("get_current_time / convert_time handlers", () => {
  it("get_current_time wraps the helper", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.get_current_time({ timezone: "UTC" }));
    expect(r.status).toBe("ok");
    expect(r.timezone).toBe("UTC");
  });
  it("get_current_time handles missing timezone", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.get_current_time({}));
    expect(r.status).toBe("ok");
  });
  it("convert_time wraps the helper", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.convert_time({ source_timezone: "UTC", time: "12:00", target_timezone: "UTC" }));
    expect(r.status).toBe("ok");
    expect(r.offset_hours).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/handlers-timer.test.ts`
Expected: All FAIL — handlers undefined.

- [ ] **Step 3: Implement — append handlers to `src/tools.ts` after the HANDLERS map declaration. Replace the `export const HANDLERS: Record<string, ToolHandler> = {};` with:**

```typescript
import { z } from "zod";
import { DateTime } from "luxon";
import { loadState, withState, makeId, type TimerRecord } from "./state.js";
import { parseDuration } from "./parsers.js";
import { getCurrentTime, convertTime } from "./time.js";

function nowIso(): string {
  return DateTime.utc().toISO() ?? new Date().toISOString();
}

function timerView(id: string, r: TimerRecord, now: DateTime): {
  timer_id: string; label: string | null; started_at: string; expires_at: string;
  cancelled_at: string | null; status: string; remaining_seconds: number;
} {
  const expires = DateTime.fromISO(r.expires_at);
  let status: string;
  if (r.cancelled_at) status = "cancelled";
  else if (now >= expires) status = "expired";
  else status = "running";
  const remainingSeconds = Math.floor(expires.diff(now, "seconds").seconds);
  return {
    timer_id: id, label: r.label, started_at: r.started_at, expires_at: r.expires_at,
    cancelled_at: r.cancelled_at, status, remaining_seconds: remainingSeconds,
  };
}

const TimerStartArgs = z.object({ duration: z.string(), label: z.string().nullish() });
const TimerIdArgs = z.object({ timer_id: z.string() });
const EmptyArgs = z.object({}).passthrough();

export const HANDLERS: Record<string, ToolHandler> = {
  async get_current_time(raw) {
    const { timezone } = z.object({ timezone: z.string().nullish() }).parse(raw);
    return getCurrentTime(timezone ?? null);
  },
  async convert_time(raw) {
    const { source_timezone, time, target_timezone } = z.object({
      source_timezone: z.string(), time: z.string(), target_timezone: z.string(),
    }).parse(raw);
    return convertTime(source_timezone, time, target_timezone);
  },
  async timer_start(raw) {
    const { duration, label } = TimerStartArgs.parse(raw);
    let seconds: number;
    try {
      seconds = parseDuration(duration);
    } catch (err) {
      return JSON.stringify({ status: "error", error: (err as Error).message });
    }
    const startedAt = nowIso();
    const expiresAt = DateTime.utc().plus({ seconds }).toISO() ?? new Date(Date.now() + seconds * 1000).toISOString();
    const id = makeId();
    await withState(async (s) => {
      s.timers[id] = { label: label ?? null, started_at: startedAt, expires_at: expiresAt, cancelled_at: null };
    });
    return JSON.stringify({ status: "ok", timer_id: id, label: label ?? null, duration_seconds: seconds, expires_at: expiresAt });
  },
  async timer_check(raw) {
    const { timer_id } = TimerIdArgs.parse(raw);
    const s = await loadState();
    const r = s.timers[timer_id];
    if (!r) return JSON.stringify({ status: "error", error: `Timer '${timer_id}' not found` });
    return JSON.stringify({ status: "ok", timer: timerView(timer_id, r, DateTime.utc()) });
  },
  async timer_list() {
    const s = await loadState();
    const now = DateTime.utc();
    const timers = Object.entries(s.timers).map(([id, r]) => timerView(id, r, now));
    return JSON.stringify({ status: "ok", count: timers.length, timers });
  },
  async timer_cancel(raw) {
    const { timer_id } = TimerIdArgs.parse(raw);
    let result: { found: boolean; view?: ReturnType<typeof timerView> } = { found: false };
    await withState(async (s) => {
      const r = s.timers[timer_id];
      if (!r) return;
      if (!r.cancelled_at) r.cancelled_at = nowIso();
      result = { found: true, view: timerView(timer_id, r, DateTime.utc()) };
    });
    if (!result.found) return JSON.stringify({ status: "error", error: `Timer '${timer_id}' not found` });
    return JSON.stringify({ status: "ok", timer: result.view });
  },
  // stopwatch handlers added in Task 7
  // alarm handlers added in Task 8
};
```

NOTE: `EmptyArgs` is declared for use in Tasks 7-8.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/handlers-timer.test.ts`
Expected: 10 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/handlers-timer.test.ts
git commit -m "feat(ts): time and timer handlers with withState mutex"
```

---

## Task 7: HANDLERS — stopwatch handlers (with idempotent stop)

**Files:**
- Modify: `src/tools.ts` (add 4 stopwatch handlers to HANDLERS)
- Create: `tests/handlers-stopwatch.test.ts`

**Spec ref:** §9.2 (idempotent `stopwatch_stop`).

- [ ] **Step 1: Write failing tests `tests/handlers-stopwatch.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "time-mcp-sw-"));
  prevEnv = process.env.TIME_MCP_STATE_DIR;
  process.env.TIME_MCP_STATE_DIR = tmp;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TIME_MCP_STATE_DIR;
  else process.env.TIME_MCP_STATE_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("stopwatch_start / check / stop / list", () => {
  it("stopwatch_start returns ok with 8-char ID", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.stopwatch_start({ label: "build" }));
    expect(r.status).toBe("ok");
    expect(r.stopwatch_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(r.label).toBe("build");
  });
  it("stopwatch_check returns running with elapsed_seconds", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.stopwatch_start({}));
    await new Promise((r) => setTimeout(r, 30));
    const check = JSON.parse(await HANDLERS.stopwatch_check({ stopwatch_id: start.stopwatch_id }));
    expect(check.stopwatch.status).toBe("running");
    expect(check.stopwatch.elapsed_seconds).toBeGreaterThanOrEqual(0);
  });
  it("stopwatch_check returns error on unknown ID", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.stopwatch_check({ stopwatch_id: "missing0" }));
    expect(r).toEqual({ status: "error", error: "Stopwatch 'missing0' not found" });
  });
  it("stopwatch_stop sets stopped_at and returns stopped status", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.stopwatch_start({ label: "x" }));
    const stop = JSON.parse(await HANDLERS.stopwatch_stop({ stopwatch_id: start.stopwatch_id }));
    expect(stop.status).toBe("ok");
    expect(stop.stopwatch.status).toBe("stopped");
    expect(stop.stopwatch.stopped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  // *** SPEC §9.2 — observable behavior change vs Python ***
  it("stopwatch_stop is IDEMPOTENT — double-stop returns OK with unchanged stopped_at", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const start = JSON.parse(await HANDLERS.stopwatch_start({}));
    const stop1 = JSON.parse(await HANDLERS.stopwatch_stop({ stopwatch_id: start.stopwatch_id }));
    await new Promise((r) => setTimeout(r, 5));
    const stop2 = JSON.parse(await HANDLERS.stopwatch_stop({ stopwatch_id: start.stopwatch_id }));
    expect(stop1.status).toBe("ok");
    expect(stop2.status).toBe("ok");
    expect(stop2.stopwatch.stopped_at).toBe(stop1.stopwatch.stopped_at); // first-stop wins
  });
  it("stopwatch_stop returns error on unknown ID", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.stopwatch_stop({ stopwatch_id: "nope1234" }));
    expect(r).toEqual({ status: "error", error: "Stopwatch 'nope1234' not found" });
  });
  it("stopwatch_list returns count and entries", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.stopwatch_start({ label: "a" });
    await HANDLERS.stopwatch_start({ label: "b" });
    const r = JSON.parse(await HANDLERS.stopwatch_list({}));
    expect(r.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/handlers-stopwatch.test.ts`
Expected: All FAIL.

- [ ] **Step 3: Add stopwatch handlers to `src/tools.ts` — add this to the HANDLERS object before the closing brace (or append after the timer handlers), and add the import + helper above HANDLERS:**

Add after the `timerView` helper:

```typescript
import type { StopwatchRecord } from "./state.js";

function stopwatchView(id: string, r: StopwatchRecord, now: DateTime): {
  stopwatch_id: string; label: string | null; started_at: string; stopped_at: string | null;
  status: string; elapsed_seconds: number;
} {
  const started = DateTime.fromISO(r.started_at);
  const end = r.stopped_at ? DateTime.fromISO(r.stopped_at) : now;
  return {
    stopwatch_id: id, label: r.label, started_at: r.started_at, stopped_at: r.stopped_at,
    status: r.stopped_at ? "stopped" : "running",
    elapsed_seconds: Math.floor(end.diff(started, "seconds").seconds),
  };
}

const StopwatchStartArgs = z.object({ label: z.string().nullish() });
const StopwatchIdArgs = z.object({ stopwatch_id: z.string() });
```

Add to HANDLERS object (inside the braces, alongside timer handlers):

```typescript
  async stopwatch_start(raw) {
    const { label } = StopwatchStartArgs.parse(raw);
    const startedAt = nowIso();
    const id = makeId();
    await withState(async (s) => {
      s.stopwatches[id] = { label: label ?? null, started_at: startedAt, stopped_at: null };
    });
    return JSON.stringify({ status: "ok", stopwatch_id: id, label: label ?? null });
  },
  async stopwatch_check(raw) {
    const { stopwatch_id } = StopwatchIdArgs.parse(raw);
    const s = await loadState();
    const r = s.stopwatches[stopwatch_id];
    if (!r) return JSON.stringify({ status: "error", error: `Stopwatch '${stopwatch_id}' not found` });
    return JSON.stringify({ status: "ok", stopwatch: stopwatchView(stopwatch_id, r, DateTime.utc()) });
  },
  // *** Spec §9.2: idempotent stop. Differs from Python — first-stop wins. ***
  async stopwatch_stop(raw) {
    const { stopwatch_id } = StopwatchIdArgs.parse(raw);
    let result: { found: boolean; view?: ReturnType<typeof stopwatchView> } = { found: false };
    await withState(async (s) => {
      const r = s.stopwatches[stopwatch_id];
      if (!r) return;
      if (!r.stopped_at) r.stopped_at = nowIso();
      result = { found: true, view: stopwatchView(stopwatch_id, r, DateTime.utc()) };
    });
    if (!result.found) return JSON.stringify({ status: "error", error: `Stopwatch '${stopwatch_id}' not found` });
    return JSON.stringify({ status: "ok", stopwatch: result.view });
  },
  async stopwatch_list() {
    const s = await loadState();
    const now = DateTime.utc();
    const stopwatches = Object.entries(s.stopwatches).map(([id, r]) => stopwatchView(id, r, now));
    return JSON.stringify({ status: "ok", count: stopwatches.length, stopwatches });
  },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/handlers-stopwatch.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/handlers-stopwatch.test.ts
git commit -m "feat(ts): stopwatch handlers; stopwatch_stop is idempotent (spec §9.2)"
```

---

## Task 8: HANDLERS — alarm handlers

**Files:**
- Modify: `src/tools.ts` (add 4 alarm handlers; smoke test should now pass)
- Create: `tests/handlers-alarm.test.ts`

- [ ] **Step 1: Write failing tests `tests/handlers-alarm.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "time-mcp-al-"));
  prevEnv = process.env.TIME_MCP_STATE_DIR;
  process.env.TIME_MCP_STATE_DIR = tmp;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TIME_MCP_STATE_DIR;
  else process.env.TIME_MCP_STATE_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("alarm_set / check / list / cancel", () => {
  it("alarm_set returns ok with alarm_id and fires_at", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.alarm_set({ when: "in 4h", label: "meeting" }));
    expect(r.status).toBe("ok");
    expect(r.alarm_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(r.label).toBe("meeting");
    expect(r.fires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("alarm_set rejects past timestamps with exact wording", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.alarm_set({ when: "2000-01-01 00:00:00" }));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/^Alarm time '2000-01-01 00:00:00' is in the past \(/);
  });
  it("alarm_set rejects unparseable input", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.alarm_set({ when: "not a real time at all" }));
    expect(r).toEqual({ status: "error", error: "Could not parse alarm time: 'not a real time at all'" });
  });
  it("alarm_check returns pending with seconds_until_fire", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const set = JSON.parse(await HANDLERS.alarm_set({ when: "in 1h" }));
    const check = JSON.parse(await HANDLERS.alarm_check({ alarm_id: set.alarm_id }));
    expect(check.alarm.status).toBe("pending");
    expect(check.alarm.seconds_until_fire).toBeGreaterThan(3500);
    expect(check.alarm.seconds_until_fire).toBeLessThanOrEqual(3600);
  });
  it("alarm_check returns error on unknown ID", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const r = JSON.parse(await HANDLERS.alarm_check({ alarm_id: "no_alarm" }));
    expect(r).toEqual({ status: "error", error: "Alarm 'no_alarm' not found" });
  });
  it("alarm_cancel is idempotent", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    const set = JSON.parse(await HANDLERS.alarm_set({ when: "in 1h" }));
    const c1 = JSON.parse(await HANDLERS.alarm_cancel({ alarm_id: set.alarm_id }));
    const c2 = JSON.parse(await HANDLERS.alarm_cancel({ alarm_id: set.alarm_id }));
    expect(c1.alarm.cancelled_at).toBe(c2.alarm.cancelled_at);
    expect(c1.alarm.status).toBe("cancelled");
  });
  it("alarm_list returns count and entries", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await HANDLERS.alarm_set({ when: "in 1h", label: "a" });
    await HANDLERS.alarm_set({ when: "in 2h", label: "b" });
    const r = JSON.parse(await HANDLERS.alarm_list({}));
    expect(r.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/handlers-alarm.test.ts`
Expected: All FAIL.

- [ ] **Step 3: Add alarm handlers to `src/tools.ts`. Add the import + helper above HANDLERS:**

```typescript
import type { AlarmRecord } from "./state.js";
import { parseAlarmTime } from "./parsers.js";

function alarmView(id: string, r: AlarmRecord, now: DateTime): {
  alarm_id: string; label: string | null; fires_at: string; cancelled_at: string | null;
  status: string; seconds_until_fire: number;
} {
  const fires = DateTime.fromISO(r.fires_at);
  let status: string;
  if (r.cancelled_at) status = "cancelled";
  else if (now >= fires) status = "fired";
  else status = "pending";
  return {
    alarm_id: id, label: r.label, fires_at: r.fires_at, cancelled_at: r.cancelled_at,
    status, seconds_until_fire: Math.floor(fires.diff(now, "seconds").seconds),
  };
}

const AlarmSetArgs = z.object({ when: z.string(), label: z.string().nullish() });
const AlarmIdArgs = z.object({ alarm_id: z.string() });
```

Add inside HANDLERS:

```typescript
  async alarm_set(raw) {
    const { when, label } = AlarmSetArgs.parse(raw);
    let fires: DateTime;
    try {
      fires = parseAlarmTime(when);
    } catch (err) {
      return JSON.stringify({ status: "error", error: (err as Error).message });
    }
    const now = DateTime.utc();
    if (fires <= now) {
      return JSON.stringify({ status: "error", error: `Alarm time '${when}' is in the past (${fires.toUTC().toISO()})` });
    }
    const firesAt = fires.toUTC().toISO() ?? "";
    const id = makeId();
    await withState(async (s) => {
      s.alarms[id] = { label: label ?? null, fires_at: firesAt, cancelled_at: null };
    });
    return JSON.stringify({ status: "ok", alarm_id: id, label: label ?? null, fires_at: firesAt });
  },
  async alarm_check(raw) {
    const { alarm_id } = AlarmIdArgs.parse(raw);
    const s = await loadState();
    const r = s.alarms[alarm_id];
    if (!r) return JSON.stringify({ status: "error", error: `Alarm '${alarm_id}' not found` });
    return JSON.stringify({ status: "ok", alarm: alarmView(alarm_id, r, DateTime.utc()) });
  },
  async alarm_list() {
    const s = await loadState();
    const now = DateTime.utc();
    const alarms = Object.entries(s.alarms).map(([id, r]) => alarmView(id, r, now));
    return JSON.stringify({ status: "ok", count: alarms.length, alarms });
  },
  async alarm_cancel(raw) {
    const { alarm_id } = AlarmIdArgs.parse(raw);
    let result: { found: boolean; view?: ReturnType<typeof alarmView> } = { found: false };
    await withState(async (s) => {
      const r = s.alarms[alarm_id];
      if (!r) return;
      if (!r.cancelled_at) r.cancelled_at = nowIso();
      result = { found: true, view: alarmView(alarm_id, r, DateTime.utc()) };
    });
    if (!result.found) return JSON.stringify({ status: "error", error: `Alarm '${alarm_id}' not found` });
    return JSON.stringify({ status: "ok", alarm: result.view });
  },
```

- [ ] **Step 4: Run alarm tests + smoke test**

Run: `npx vitest run tests/handlers-alarm.test.ts tests/smoke.test.ts`
Expected: All pass (7 alarm tests + 1 smoke test). The smoke test was failing before; now `HANDLERS` has all 14 entries.

- [ ] **Step 5: Run full suite — should now have all unit tests green**

Run: `npx vitest run`
Expected: ~50+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/handlers-alarm.test.ts
git commit -m "feat(ts): alarm handlers; smoke test green (TOOLS↔HANDLERS symmetry)"
```

---

## Task 9: index.ts — MCP server wiring

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```typescript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HANDLERS, TOOLS } from "./tools.js";

const server = new Server(
  { name: "time-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Error: unknown tool '${name}'` }], isError: true };
  }
  try {
    const text = await handler(args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`time-mcp: handler '${name}' threw: ${msg}\n`);
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: msg }) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("time-mcp: connected on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`time-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: emits `dist/index.js`, `dist/tools.js`, etc.

- [ ] **Step 3: Smoke-boot the built server**

A quick stdin/stdout handshake test. Create `scripts/handshake-check.mjs` (not committed — just for the smoke):

```javascript
import { spawn } from "node:child_process";
const proc = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
proc.stdout.on("data", (d) => { stdout += d.toString(); });
proc.stderr.on("data", (d) => process.stderr.write(`STDERR: ${d}`));
setTimeout(() => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n"), 8000);
setTimeout(() => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"), 9000);
setTimeout(() => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n"), 9500);
setTimeout(() => {
  console.log(stdout);
  proc.kill();
  process.exit(0);
}, 13000);
```

Run: `node scripts/handshake-check.mjs`
Expected: stdout contains a `tools/list` response with all 14 tool names. Stderr shows `"time-mcp: connected on stdio"`.

- [ ] **Step 4: Delete the throwaway script**

```bash
rm scripts/handshake-check.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(ts): MCP server wiring with ListTools/CallTool dispatch"
```

---

## Task 10: notify-hook.ts — separate CLI entry point

**Files:**
- Create: `src/notify-hook.ts`
- Create: `tests/notify-hook.test.ts`

**Spec ref:** §7.

- [ ] **Step 1: Write failing tests `tests/notify-hook.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { collectNotifications, formatSeconds } from "../src/notify-hook.js";
import type { State } from "../src/state.js";

describe("formatSeconds", () => {
  it("formats seconds", () => { expect(formatSeconds(10)).toBe("10s"); });
  it("formats minutes (integer div)", () => { expect(formatSeconds(125)).toBe("2m"); });
  it("formats hours", () => { expect(formatSeconds(7200)).toBe("2h"); });
  it("formats days", () => { expect(formatSeconds(172800)).toBe("2d"); });
  it("edge: 60 -> 1m", () => { expect(formatSeconds(60)).toBe("1m"); });
  it("edge: 3600 -> 1h", () => { expect(formatSeconds(3600)).toBe("1h"); });
});

describe("collectNotifications", () => {
  const now = DateTime.fromISO("2026-05-22T12:00:00Z", { zone: "utc" });
  function baseState(): State {
    return { timers: {}, stopwatches: {}, alarms: {} };
  }
  it("emits no lines when nothing is expired", () => {
    const s = baseState();
    s.timers.a1 = { label: "x", started_at: "2026-05-22T11:00:00Z", expires_at: "2026-05-22T13:00:00Z", cancelled_at: null };
    const { lines } = collectNotifications(s, now);
    expect(lines).toEqual([]);
  });
  it("emits for expired uncancelled, unnotified timers", () => {
    const s = baseState();
    s.timers.a1 = { label: "deploy", started_at: "2026-05-22T11:00:00Z", expires_at: "2026-05-22T11:58:00Z", cancelled_at: null };
    const { lines, state } = collectNotifications(s, now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\u{1F514} Timer 'deploy' \(a1\) expired 2m ago$/u);
    expect(state.timers.a1.notified_at).toBe(now.toISO());
  });
  it("skips already-notified timers", () => {
    const s = baseState();
    s.timers.a1 = { label: "x", started_at: "t", expires_at: "2026-05-22T11:58:00Z", cancelled_at: null, notified_at: "2026-05-22T11:59:00Z" };
    expect(collectNotifications(s, now).lines).toEqual([]);
  });
  it("skips cancelled", () => {
    const s = baseState();
    s.timers.a1 = { label: "x", started_at: "t", expires_at: "2026-05-22T11:58:00Z", cancelled_at: "2026-05-22T11:30:00Z" };
    expect(collectNotifications(s, now).lines).toEqual([]);
  });
  it("emits for fired alarms with no label", () => {
    const s = baseState();
    s.alarms.b2 = { label: null, fires_at: "2026-05-22T10:00:00Z", cancelled_at: null };
    const { lines } = collectNotifications(s, now);
    expect(lines[0]).toMatch(/^\u{1F514} Alarm \(b2\) fired 2h ago$/u);
  });
  it("preserves insertion order across timers then alarms", () => {
    const s = baseState();
    s.timers.t1 = { label: "first", started_at: "t", expires_at: "2026-05-22T11:00:00Z", cancelled_at: null };
    s.timers.t2 = { label: "second", started_at: "t", expires_at: "2026-05-22T11:30:00Z", cancelled_at: null };
    s.alarms.a1 = { label: "third", fires_at: "2026-05-22T11:50:00Z", cancelled_at: null };
    const { lines } = collectNotifications(s, now);
    expect(lines.map((l) => l.match(/'(\w+)'/)?.[1])).toEqual(["first", "second", "third"]);
  });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `npx vitest run tests/notify-hook.test.ts`
Expected: All FAIL.

- [ ] **Step 3: Implement `src/notify-hook.ts`**

```typescript
#!/usr/bin/env node
import { DateTime } from "luxon";
import { loadState, saveState, type State } from "./state.js";

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function labelPart(label: string | null | undefined): string {
  return label ? ` '${label}'` : "";
}

export function collectNotifications(state: State, now: DateTime): { lines: string[]; state: State } {
  const lines: string[] = [];
  const nowIso = now.toISO() ?? "";

  for (const [timerId, record] of Object.entries(state.timers)) {
    if (record.cancelled_at || record.notified_at) continue;
    const expiresAt = DateTime.fromISO(record.expires_at);
    if (now < expiresAt) continue;
    const ago = formatSeconds(Math.floor(now.diff(expiresAt, "seconds").seconds));
    lines.push(`\u{1F514} Timer${labelPart(record.label)} (${timerId}) expired ${ago} ago`);
    record.notified_at = nowIso;
  }

  for (const [alarmId, record] of Object.entries(state.alarms)) {
    if (record.cancelled_at || record.notified_at) continue;
    const firesAt = DateTime.fromISO(record.fires_at);
    if (now < firesAt) continue;
    const ago = formatSeconds(Math.floor(now.diff(firesAt, "seconds").seconds));
    lines.push(`\u{1F514} Alarm${labelPart(record.label)} (${alarmId}) fired ${ago} ago`);
    record.notified_at = nowIso;
  }

  return { lines, state };
}

async function readStdin(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", () => resolve());
    // If nothing is piped in, just resolve quickly.
    setTimeout(() => resolve(), 50);
  });
}

async function main(): Promise<number> {
  try { await readStdin(); } catch { /* ignore */ }

  let state: State;
  try {
    state = await loadState();
  } catch {
    return 0;
  }

  const { lines, state: mutated } = collectNotifications(state, DateTime.utc());
  if (lines.length === 0) return 0;

  try {
    await saveState(mutated);
  } catch {
    // If save fails, still emit notifications — better to duplicate next turn than silently drop.
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/notify-hook.test.ts`
Expected: 13 tests pass.

- [ ] **Step 5: Build + verify dist/notify-hook.js exists**

Run: `npm run build`
Expected: `dist/notify-hook.js` present.

- [ ] **Step 6: Run full suite end-to-end**

Run: `npx vitest run`
Expected: ≥58 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/notify-hook.ts tests/notify-hook.test.ts
git commit -m "feat(ts): notify-hook CLI entry — port of UserPromptSubmit hook"
```

---

## Task 11: Cutover (.mcp.json + settings.json)

**Files:**
- Modify: `C:/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json`
- Modify: `C:/Users/danie/.claude/settings.json`

- [ ] **Step 1: Back up .mcp.json**

```bash
cp /c/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json /c/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json.bak-2026-05-22-pre-time-mcp-ts-cutover
```

- [ ] **Step 2: Back up settings.json**

```bash
cp /c/Users/danie/.claude/settings.json /c/Users/danie/.claude/settings.json.bak-2026-05-22-pre-time-mcp-ts-cutover
```

- [ ] **Step 3: Edit .mcp.json — replace the `time-mcp` block**

Replace:
```json
"time-mcp": {
  "type": "stdio",
  "command": "C:/Users/danie/.venvs/time-mcp/Scripts/python.exe",
  "args": ["-X", "utf8", "-m", "time_mcp_server"],
  "env": { "_RETRY": "2026-05-19T05-37-41" }
}
```
With:
```json
"time-mcp": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/Users/danie/Dropbox/Github/time-mcp/dist/index.js"],
  "env": { "_RETRY": "2026-05-22-time-mcp-ts-cutover" }
}
```

- [ ] **Step 4: Edit settings.json — UserPromptSubmit hook**

Replace:
```json
{
  "type": "command",
  "command": "C:/Users/danie/.venvs/time-mcp/Scripts/python.exe -m time_mcp_server.notify_hook",
  "timeout": 5
}
```
With:
```json
{
  "type": "command",
  "command": "node C:/Users/danie/Dropbox/Github/time-mcp/dist/notify-hook.js",
  "timeout": 5
}
```

- [ ] **Step 5: Validate both JSONs**

Run: `python -c "import json; json.load(open(r'C:/Users/danie/.claude/local-marketplace/mcp-host/.mcp.json')); json.load(open(r'C:/Users/danie/.claude/settings.json')); print('both valid')"`
Expected: `both valid`.

- [ ] **Step 6: User runs `/reload-plugins`** — this is the user's action; agent waits for confirmation.

---

## Task 12: Live verification + cleanup

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md` (or modify if exists)
- Remove: `src/time_mcp_server/`, `pyproject.toml`, `requirements.txt`
- Retire: `C:/Users/danie/.venvs/time-mcp` (post-verification only)

- [ ] **Step 1: Live verify `get_current_time`**

Call `mcp__plugin_mcp-host_time-mcp__get_current_time` with `{"timezone": "UTC"}`.
Expected: `{"status": "ok", "timezone": "UTC", ...}`.

- [ ] **Step 2: Live verify timer round-trip**

Call `timer_start` with `{"duration": "5m", "label": "verify"}` → expect 8-char `timer_id`.
Call `timer_check` with that ID → expect `"status":"running"`, `remaining_seconds` near 300.
Call `timer_cancel` with that ID → expect `"status":"cancelled"`.

- [ ] **Step 3: Live verify notify-hook end-to-end**

(Optional but high-confidence): set a `timer_start` with `"duration": "5s"`, wait 10 seconds, then submit a Claude Code prompt. Expected: the prompt context contains "🔔 Timer 'verify' (...) expired ... ago".

- [ ] **Step 4: Update README.md**

Add a "Build & run" section explaining the TypeScript implementation, dependencies, and invocation. Match dropbox-mcp's README structure.

- [ ] **Step 5: Add CHANGELOG entry**

```markdown
## [0.2.0] - 2026-05-22

### Changed
- **Rewrote in TypeScript** on `@modelcontextprotocol/sdk`. Python `time_mcp_server` package retired. Invocation changes from `python -m time_mcp_server` to `node dist/index.js`.
- The UserPromptSubmit hook now invokes `node dist/notify-hook.js` instead of the Python module. Behavior unchanged.
- **`stopwatch_stop` is now idempotent.** Stopping an already-stopped stopwatch returns OK with the original `stopped_at`, instead of erroring `"Stopwatch '<id>' is already stopped"`. This matches the behavior of `timer_cancel` and `alarm_cancel`.

### Fixed
- Concurrent state mutations are now serialized via a Promise-chain mutex; previously, two simultaneous tool calls could lose one's update.
- Corrupted `state.json` is now backed up to `state.json.corrupted.<timestamp>` and logged to stderr, instead of being silently discarded.
- State save/load failures log to stderr (previously silent).

### Added
- `readOnlyHint`/`destructiveHint` annotations on all 14 tools, exposed via the MCP SDK's Tool schema (Python FastMCP didn't surface these).
```

- [ ] **Step 6: Remove Python source**

```bash
git rm -r src/time_mcp_server
git rm pyproject.toml requirements.txt 2>/dev/null || true
```

- [ ] **Step 7: Commit cleanup**

```bash
git add README.md CHANGELOG.md
git commit -m "chore: complete TypeScript conversion; retire Python time_mcp_server"
```

- [ ] **Step 8: Retire venv** (user confirms first)

```powershell
Remove-Item -Recurse -Force C:/Users/danie/.venvs/time-mcp
```

- [ ] **Step 9: Update task #251 to completed**

Use TaskUpdate to mark #251 done; #252 (gmail-mcp) unblocks automatically.

---

## Self-review (writing-plans skill)

**Spec coverage:** Each spec section is covered: §1 (Tasks 1, 5-10), §3 (Tasks 2-10), §4 (Task 2), §5 (Task 3), §6 (Task 4), §7 (Task 10), §8 (Tasks 2-10), §9.1 (Task 2), §9.2 (Task 7), §9.3 (Task 2), §9.4 (Task 5), §9.5 (Tasks 2, 9), §10 (every Task creates its tests), §11 (Task 11), §12 (Task 12). No gaps.

**Placeholder scan:** No "TBD", no "implement later", no "similar to". All code blocks are complete. Bash commands are real.

**Type consistency:** `State`, `TimerRecord`, `StopwatchRecord`, `AlarmRecord` defined in Task 2 used identically in Tasks 6/7/8. `ToolHandler` type defined Task 5 used everywhere. `HANDLERS` mutates the same map across Tasks 6/7/8 — the final smoke test (in Task 8) is when it becomes complete.

**Ambiguity check:** First-stop-wins semantics explicitly tested. JSON shape pinned by test assertions. Error strings quoted verbatim. Cutover backup paths named. Risk: Task 6's `loadState` call inside `timer_check` reads fresh from disk every time — *correct* per spec §9.1 (only mutations are mutex'd, reads are lock-free).
