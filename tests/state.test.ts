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
