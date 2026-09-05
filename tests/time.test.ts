import { describe, it, expect, setSystemTime } from "bun:test";
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
  it("rejects DST spring-forward gap (02:30 on 2026-03-08 in America/New_York)", () => {
    // March 8, 2026 02:30 EST does not exist — clocks jump from 01:59 to 03:00.
    // Pin `now` to 12:00 UTC that day so today's date in NY is 2026-03-08.
    setSystemTime(new Date("2026-03-08T12:00:00Z"));
    try {
      const r = JSON.parse(convertTime("America/New_York", "02:30", "UTC"));
      expect(r.status).toBe("error");
      expect(r.error).toBe(
        "Time '02:30' does not exist in America/New_York on 2026-03-08 (DST spring-forward gap)",
      );
    } finally {
      setSystemTime();
    }
  });
  it("accepts the wall-clock hour just before a DST gap", () => {
    // 01:30 on 2026-03-08 NY DOES exist (still EST before the jump).
    setSystemTime(new Date("2026-03-08T12:00:00Z"));
    try {
      const r = JSON.parse(convertTime("America/New_York", "01:30", "UTC"));
      expect(r.status).toBe("ok");
    } finally {
      setSystemTime();
    }
  });
});
