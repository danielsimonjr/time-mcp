import { describe, it, expect } from "bun:test";
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
