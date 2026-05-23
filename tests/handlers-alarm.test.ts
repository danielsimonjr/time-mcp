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
