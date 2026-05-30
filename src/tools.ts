import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DateTime } from "luxon";
import { loadState, withState, makeId, type TimerRecord, type StopwatchRecord, type AlarmRecord } from "./state.js";
import { parseDuration, parseAlarmTime } from "./parsers.js";
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
      "Set an alarm at an absolute or natural-language time ('in 4h', 'tomorrow at 9am', '2030-12-31 23:59:00'). Returns alarm_id. Naive absolute strings and 'today/tomorrow' patterns are interpreted in the given timezone (optional; defaults to UTC).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", description: "Natural language or absolute time." },
        label: { type: "string", description: "Optional human-readable name." },
        timezone: {
          type: "string",
          description: "IANA timezone name to anchor naive times (e.g. 'America/New_York'). Omit to use UTC.",
        },
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
  const iso = DateTime.utc().toISO();
  if (!iso) throw new Error("DateTime.utc().toISO() returned null — Luxon internal error");
  return iso;
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

const AlarmSetArgs = z.object({ when: z.string(), label: z.string().nullish(), timezone: z.string().nullish() });
const AlarmIdArgs = z.object({ alarm_id: z.string() });

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
    const expiresAtRaw = DateTime.utc().plus({ seconds }).toISO();
    if (!expiresAtRaw) throw new Error("DateTime.utc().plus().toISO() returned null — Luxon internal error");
    const expiresAt = expiresAtRaw;
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
    let found = false;
    let view: ReturnType<typeof timerView> | null = null;
    await withState(async (s) => {
      const r = s.timers[timer_id];
      if (!r) return;
      const now = DateTime.utc();
      const nowStr = now.toISO();
      if (!nowStr) throw new Error("DateTime.utc().toISO() returned null");
      if (!r.cancelled_at) r.cancelled_at = nowStr;
      found = true;
      view = timerView(timer_id, r, now);
    });
    if (!found) return JSON.stringify({ status: "error", error: `Timer '${timer_id}' not found` });
    return JSON.stringify({ status: "ok", timer: view });
  },
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
    let found = false;
    let view: ReturnType<typeof stopwatchView> | null = null;
    await withState(async (s) => {
      const r = s.stopwatches[stopwatch_id];
      if (!r) return;
      const now = DateTime.utc();
      const nowStr = now.toISO();
      if (!nowStr) throw new Error("DateTime.utc().toISO() returned null");
      if (!r.stopped_at) r.stopped_at = nowStr;
      found = true;
      view = stopwatchView(stopwatch_id, r, now);
    });
    if (!found) return JSON.stringify({ status: "error", error: `Stopwatch '${stopwatch_id}' not found` });
    return JSON.stringify({ status: "ok", stopwatch: view });
  },
  async stopwatch_list() {
    const s = await loadState();
    const now = DateTime.utc();
    const stopwatches = Object.entries(s.stopwatches).map(([id, r]) => stopwatchView(id, r, now));
    return JSON.stringify({ status: "ok", count: stopwatches.length, stopwatches });
  },
  async alarm_set(raw) {
    const { when, label, timezone } = AlarmSetArgs.parse(raw);
    let fires: DateTime;
    try {
      fires = parseAlarmTime(when, timezone ?? undefined);
    } catch (err) {
      return JSON.stringify({ status: "error", error: (err as Error).message });
    }
    const now = DateTime.utc();
    if (fires <= now) {
      return JSON.stringify({ status: "error", error: `Alarm time '${when}' is in the past (${fires.toUTC().toISO()})` });
    }
    const firesAtRaw = fires.toUTC().toISO();
    if (!firesAtRaw) throw new Error("fires.toUTC().toISO() returned null — Luxon internal error");
    const firesAt = firesAtRaw;
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
    let found = false;
    let view: ReturnType<typeof alarmView> | null = null;
    await withState(async (s) => {
      const r = s.alarms[alarm_id];
      if (!r) return;
      const now = DateTime.utc();
      const nowStr = now.toISO();
      if (!nowStr) throw new Error("DateTime.utc().toISO() returned null");
      if (!r.cancelled_at) r.cancelled_at = nowStr;
      found = true;
      view = alarmView(alarm_id, r, now);
    });
    if (!found) return JSON.stringify({ status: "error", error: `Alarm '${alarm_id}' not found` });
    return JSON.stringify({ status: "ok", alarm: view });
  },
};
