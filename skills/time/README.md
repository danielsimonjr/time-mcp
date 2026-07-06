# time

Playbook for the `time-mcp` server's 14 tools — current time lookup, timezone conversion, and three ephemeral-state families: timers (count down), stopwatches (count up), and alarms (fire at a wall-clock time).

## Purpose

A judgment layer over the `time-mcp` server. This skill adds no tools of its own — every action composes existing MCP tools. It steers you toward the right family for what the user actually means (countdown vs. count-up vs. absolute-time firing) and keeps the `_id`-based start/check/cancel/list flow correct for each.

Covers:
- **Clock** — `get_current_time`, `convert_time`
- **Timer** — `timer_start` / `timer_check` / `timer_cancel` / `timer_list`
- **Stopwatch** — `stopwatch_start` / `stopwatch_stop` / `stopwatch_check` / `stopwatch_list`
- **Alarm** — `alarm_set` / `alarm_check` / `alarm_cancel` / `alarm_list`

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Full playbook: tool map, per-family usage, picking the right family |
| `README.md` | This overview |

## Triggers

Loads as `time-mcp:time`; explicit slash trigger: `/time`.

Auto-loads on queries like "what time is it", "what's the time in `<zone>`", "convert `<time>` to `<zone>`", "set a timer for N minutes", "start/check/cancel a stopwatch", "set an alarm for `<time>`", or any question about elapsed or remaining time.

## Scope

All 14 tools are safe — reads and ephemeral, freely cancellable state, no destructive or external side effects. For full usage details and gotchas, see `SKILL.md`.
