import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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

// HANDLERS map — populated incrementally in Tasks 6, 7, 8.
export const HANDLERS: Record<string, ToolHandler> = {};
