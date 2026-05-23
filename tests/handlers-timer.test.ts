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
