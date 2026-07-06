---
name: time
description: "Playbook for the time-mcp server: current time, timezone conversion, and timers/stopwatches/alarms. Use when the user says 'what time is it', 'what's the time in <zone>', 'convert <time> to <zone>', 'set a timer for N minutes', 'start/check/cancel a stopwatch', 'set an alarm for <time>', or asks about elapsed/remaining time. All operations are safe (read + ephemeral timers)."
---

# Time

A judgment layer over the `time-mcp` server's 14 tools — current time lookup, timezone conversion, and three independent ephemeral-state families (timers, stopwatches, alarms). This skill adds no tools of its own: every action below is one of the server's existing MCP tools. Its job is to steer you toward the right tool for the family the user means (counting down vs. counting up vs. firing at a wall-clock time), and to keep the `_id`-based check/cancel/list flow correct.

**Skill root**: this skill ships inside the `time-mcp` plugin (repo `danielsimonjr/time-mcp`, `skills/time/`). Slash trigger: `/time`.

## Tool map

| Family | Tools | Purpose |
|---|---|---|
| **Clock** | `get_current_time`, `convert_time` | Read the current time in a zone; convert a `HH:MM` between two zones. |
| **Timer** | `timer_start`, `timer_check`, `timer_cancel`, `timer_list` | Counts **down** from a duration to zero. |
| **Stopwatch** | `stopwatch_start`, `stopwatch_stop`, `stopwatch_check`, `stopwatch_list` | Counts **up** from zero until stopped. |
| **Alarm** | `alarm_set`, `alarm_check`, `alarm_cancel`, `alarm_list` | Fires once at an absolute **wall-clock time**. |

### Clock

`get_current_time(timezone?)` returns ISO datetime, `HH:MM:SS`, and `is_dst` for an IANA timezone (e.g. `America/New_York`, `UTC`); omit `timezone` to get system-local, falling back to UTC. `convert_time(time, source_timezone, target_timezone)` converts a `HH:MM` (24-hour) from one IANA zone to another using today's date in the source zone — use this for "what's 14:30 in Tokyo if it's 14:30 in New York" style questions, not for converting a full past/future date.

### Timer

`timer_start(duration, label?)` takes a duration string (`"5m"`, `"1h30m"`, `"90s"`, `"1d2h3m4s"`, or a bare integer of seconds) and returns an 8-character `timer_id`. Use `timer_check(timer_id)` to get status (`running`/`expired`/`cancelled`) and remaining seconds, `timer_cancel(timer_id)` to stop it early (idempotent — cancelling an already-cancelled timer is fine), and `timer_list()` to see all timers regardless of state.

### Stopwatch

`stopwatch_start(label?)` returns a `stopwatch_id` and begins counting up immediately. `stopwatch_check(stopwatch_id)` reports `running`/`stopped` and elapsed seconds; `stopwatch_stop(stopwatch_id)` stops it (idempotent — stopping an already-stopped stopwatch returns the unchanged `stopped_at`). `stopwatch_list()` lists all stopwatches, running and stopped.

### Alarm

`alarm_set(when, label?, timezone?)` accepts natural language (`"in 4h"`, `"tomorrow at 9am"`) or an absolute string (`"2030-12-31 23:59:00"`) and returns an `alarm_id`. Naive absolute times and "today/tomorrow" phrasing are anchored to `timezone` if given, else UTC — pass the user's zone explicitly rather than assuming local. `alarm_check(alarm_id)` reports status (`pending`/`fired`/`cancelled`) and seconds until fire; `alarm_cancel(alarm_id)` cancels (idempotent); `alarm_list()` lists all alarms across every status.

## Picking the right family

- Something that should count **down** to zero and stop (a cooking timer, a break reminder) → **Timer**.
- Something that should count **up** indefinitely until you stop it (measuring how long a task takes) → **Stopwatch**.
- Something that should fire once at a specific **clock time**, possibly far in the future or across a date boundary → **Alarm**.

If a `time-mcp` tool isn't loaded yet, fetch its schema:

```
ToolSearch select:mcp__plugin_time-mcp_time-mcp__get_current_time
```

(swap in any of the other 13 tool names as needed — `convert_time`, `timer_start`, `timer_check`, `timer_cancel`, `timer_list`, `stopwatch_start`, `stopwatch_stop`, `stopwatch_check`, `stopwatch_list`, `alarm_set`, `alarm_check`, `alarm_cancel`, `alarm_list`).

## Safety note

Every tool in this family is safe to call without confirmation: clock reads are pure lookups, and timers/stopwatches/alarms are ephemeral, freely cancellable state with no destructive or external side effects. Call them directly — no need to check in with the user first.
