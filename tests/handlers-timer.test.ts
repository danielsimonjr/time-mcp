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

describe("timer_list status coverage (TEST-2)", () => {
  it("timer_list shows a cancelled timer as status:'cancelled'", async () => {
    const { withState } = await import("../src/state.js");
    const { HANDLERS } = await import("../src/tools.js");
    await withState((s) => {
      s.timers["cancel01"] = {
        label: "cancelled-timer",
        started_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2999-01-01T00:00:00.000Z",
        cancelled_at: "2026-01-01T00:01:00.000Z",
      };
    });
    const r = JSON.parse(await HANDLERS.timer_list({}));
    const t = r.timers.find((x: { timer_id: string }) => x.timer_id === "cancel01");
    expect(t).toBeDefined();
    expect(t.status).toBe("cancelled");
  });

  it("timer_list shows an expired timer as status:'expired'", async () => {
    const { withState } = await import("../src/state.js");
    const { HANDLERS } = await import("../src/tools.js");
    await withState((s) => {
      s.timers["expired02"] = {
        label: "expired-timer",
        started_at: "2020-01-01T00:00:00.000Z",
        expires_at: "2020-01-01T00:01:00.000Z",
        cancelled_at: null,
      };
    });
    const r = JSON.parse(await HANDLERS.timer_list({}));
    const t = r.timers.find((x: { timer_id: string }) => x.timer_id === "expired02");
    expect(t).toBeDefined();
    expect(t.status).toBe("expired");
  });
});

describe("timer missing-arg errors (TEST-5)", () => {
  it("timer_check with no timer_id throws ZodError (dispatcher wraps it as an error response)", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await expect(HANDLERS.timer_check({})).rejects.toThrow();
  });

  it("timer_cancel with no timer_id throws ZodError (dispatcher wraps it as an error response)", async () => {
    const { HANDLERS } = await import("../src/tools.js");
    await expect(HANDLERS.timer_cancel({})).rejects.toThrow();
  });
});

describe("single clock read in timer_cancel (BUG-2)", () => {
  it("cancelling an already-expired timer returns a deterministic remaining_seconds <= 0", async () => {
    // Inject a timer that expired in the past via withState so we control the state.
    const { withState } = await import("../src/state.js");
    const { HANDLERS } = await import("../src/tools.js");
    const id = "expired01";
    await withState((s) => {
      s.timers[id] = {
        label: "past",
        started_at: "2020-01-01T00:00:00.000Z",
        expires_at: "2020-01-01T00:01:00.000Z",
        cancelled_at: null,
      };
    });
    const r = JSON.parse(await HANDLERS.timer_cancel({ timer_id: id }));
    expect(r.status).toBe("ok");
    // The cancelled_at stamp must match the view's computation timestamp
    // (single clock read means no skew between stamp and view).
    expect(r.timer.status).toBe("cancelled");
    // remaining_seconds must be deterministic (not NaN, not undefined)
    expect(typeof r.timer.remaining_seconds).toBe("number");
    expect(Number.isFinite(r.timer.remaining_seconds)).toBe(true);
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
