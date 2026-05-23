import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DateTime } from "luxon";
import { loadState, withState, makeId, type TimerRecord } from "./state.js";
import { parseDuration } from "./parsers.js";
import { getCurrentTime, convertTime } from "./time.js";

export type ToolHandler = (raw: unknown) => Promise<string>;

const TZ_DESC =
  "IANA timezone name (e.g., 'America/New_York', 'UTC'). Optional — defaults to system local zone, then UTC.";

export const TOOLS: Tool[] = [
  {
    name: "get_current_time",
    description:
      "Get the current time in a given timezone (or system local if not specified). Returns ISO datetime, HH:MM:SS, and is_dst.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { timezone: { type: "string", description: TZ_DESC } },
      additionalProperties: false,
    },
  },
  {
    name: "convert_time",
    description:
      "Convert a HH:MM time from one timezone to another, using today's date in the source zone.",
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
    description:
      "Start a countdown timer. Duration like '5m', '1h30m', '90s', or '0s'. Returns timer_id (8 chars) for later check/cancel.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        duration: {
          type: "string",
          description:
            "e.g. '5m', '1h30m', '90s', '1d2h3m4s', or a bare integer in seconds.",
        },
        label: { type: "string", description: "Optional human-readable name." },
      },
      required: ["duration"],
      additionalProperties: false,
    },
  },
  {
    name: "timer_check",
    description:
      "Look up a timer by ID and return its current status (running / expired / cancelled) and remaining seconds.",
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
    description:
      "Cancel a timer by ID. Idempotent — cancelling an already-cancelled timer returns OK.",
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
    description:
      "Start a count-up stopwatch. Returns stopwatch_id for later check/stop.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Optional human-readable name." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stopwatch_check",
    description:
      "Look up a stopwatch by ID and return its current status (running / stopped) and elapsed seconds.",
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
    description:
      "Stop a stopwatch by ID. Idempotent — stopping an already-stopped stopwatch returns OK with unchanged stopped_at.",
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
    description:
      "Set an alarm at an absolute or natural-language time ('in 4h', 'tomorrow at 9am', '2030-12-31 23:59:00'). Returns alarm_id.",
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
    description:
      "Look up an alarm by ID and return its current status (pending / fired / cancelled) and seconds until fire.",
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
    description:
      "Cancel an alarm by ID. Idempotent — cancelling an already-cancelled alarm returns OK.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { alarm_id: { type: "string" } },
      required: ["alarm_id"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers and Zod schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HANDLERS map — populated incrementally in Tasks 6, 7, 8.
// ---------------------------------------------------------------------------

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
