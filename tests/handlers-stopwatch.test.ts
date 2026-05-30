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

describe("stopwatch_list status coverage (TEST-4)", () => {
  it("stopwatch_list shows a stopped stopwatch as status:'stopped'", async () => {
    const { withState } = await import("../src/state.js");
    const { HANDLERS } = await import("../src/tools.js");
    await withState((s) => {
      s.stopwatches["stopped1"] = {
        label: "stopped-sw",
        started_at: "2026-01-01T00:00:00.000Z",
        stopped_at: "2026-01-01T00:05:00.000Z",
      };
    });
    const r = JSON.parse(await HANDLERS.stopwatch_list({}));
    const sw = r.stopwatches.find((x: { stopwatch_id: string }) => x.stopwatch_id === "stopped1");
    expect(sw).toBeDefined();
    expect(sw.status).toBe("stopped");
    expect(sw.elapsed_seconds).toBe(300);
  });

  it("stopwatch_list shows a running stopwatch as status:'running'", async () => {
    const { withState } = await import("../src/state.js");
    const { HANDLERS } = await import("../src/tools.js");
    await withState((s) => {
      s.stopwatches["running1"] = {
        label: "running-sw",
        started_at: new Date(Date.now() - 10000).toISOString(),
        stopped_at: null,
      };
    });
    const r = JSON.parse(await HANDLERS.stopwatch_list({}));
    const sw = r.stopwatches.find((x: { stopwatch_id: string }) => x.stopwatch_id === "running1");
    expect(sw).toBeDefined();
    expect(sw.status).toBe("running");
  });
});

describe("stopwatch missing-arg errors (TEST-5)", () => {
  it("stopwatch_check with no stopwatch_id returns structured error (ZodError)", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await expect(HANDLERS.stopwatch_check({})).rejects.toThrow();
  });

  it("stopwatch_stop with no stopwatch_id returns structured error (ZodError)", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await expect(HANDLERS.stopwatch_stop({})).rejects.toThrow();
  });
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
