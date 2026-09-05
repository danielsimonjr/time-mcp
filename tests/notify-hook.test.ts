import { describe, it, expect } from "bun:test";
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
