# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `time_mcp_server.notify_hook` module — Claude Code `UserPromptSubmit`
  hook that injects emoji-prefixed notifications for expired timers and
  fired alarms into the session context. One-shot semantics via a
  `notified_at` field on each record (existing records without the field
  are treated as pending; schema-repair on first save). Designed to fail
  silently (always returns exit 0) so a malformed state file or other
  unexpected error never blocks the user's prompt.
- 11 unit tests for the hook including pure-function `collect_notifications`
  coverage (empty state, expired timer, fired alarm, cancelled-skip,
  already-notified-skip, running-skip, unlabeled-items, multiple-items,
  legacy records without `notified_at`) plus 2 subprocess smoke tests
  (no-state exit, expired-timer JSON output + persistence).
- README "Notification hook (optional)" section with `settings.json`
  config snippet.

### Changed
- `src/time_mcp_server/__init__.py` no longer eagerly imports
  `time_mcp_server.server` at package load time. This keeps
  `import time_mcp_server.notify_hook` cheap (avoids pulling in FastMCP /
  pydantic / dateparser per `UserPromptSubmit` hook fire). Tests and the
  `python -m time_mcp_server` entry point continue to import from
  submodules directly.

### Added
- Four alarm (absolute-time fire) tools: `alarm_set(when, label?)`,
  `alarm_list()`, `alarm_check(alarm_id)`, `alarm_cancel(alarm_id)`. State
  persisted under `state["alarms"]`. Status (`pending` / `fired` /
  `cancelled`) is computed at read time. Accepts natural-language times
  via `parse_alarm_time` (e.g. `"in 4 hours"`, `"tomorrow at 9am"`,
  `"2030-12-31 23:59:00"`); times in the past are rejected. `alarm_cancel`
  is idempotent.
- 12 unit tests for alarm lifecycle including absolute/relative input,
  fired status via injected past timestamps, mixed-status list, past-time
  rejection.
- Four stopwatch (count-up) tools: `stopwatch_start(label?)`,
  `stopwatch_stop(stopwatch_id)`, `stopwatch_check(stopwatch_id)`,
  `stopwatch_list()`. State persisted under `state["stopwatches"]`. Status
  (`running` / `stopped`) and elapsed time are computed at read time.
  `stopwatch_stop` is **not** idempotent — stopping an already-stopped
  stopwatch returns an error so double-stop bugs surface clearly.
- 10 unit tests for stopwatch lifecycle including injected-state checks
  for both running and stopped variants.
- Four timer (countdown) tools: `timer_start(duration, label?)`,
  `timer_list()`, `timer_check(timer_id)`, `timer_cancel(timer_id)`. State
  is persisted under `state["timers"]`. Status (`running` / `expired` /
  `cancelled`) is *computed* at read time from `expires_at` and
  `cancelled_at` — no daemon needed. `timer_cancel` is idempotent. All
  durations parsed via `/loop`-compatible syntax (`5m`, `1h30m`, `90s`, …).
- 12 unit tests for timer lifecycle including expired-via-injected-state,
  cancellation flow, missing-ID errors, and idempotent cancel.
- Persistence layer at `src/time_mcp_server/state.py`: JSON state file at
  `~/.time-mcp/state.json` (override via `TIME_MCP_STATE_DIR`), atomic writes
  via tempfile + `os.replace` with 3-attempt retry-on-Windows-sharing-violation,
  forward-compatible schema repair, UTF-8 throughout (labels with emoji or
  accented characters round-trip cleanly).
- `make_id()` helper returning 8-char base64url IDs (~48 bits entropy).
- Parsers module at `src/time_mcp_server/parsers.py`:
  - `parse_duration` accepts `5m`, `1h30m`, `90s`, `1d2h3m4s`, or a bare
    integer (seconds), matching `/loop`'s syntax. Rejects out-of-order
    components, decimals, negatives, and unknown units.
  - `parse_alarm_time` wraps `dateparser` with deterministic UTC-default
    interpretation of naive absolute timestamps; relative phrases like
    "in 4 hours" and "tomorrow at 9am" supported. Optional `tz_name` lets
    callers anchor naive strings in a specific zone.
- 31 new unit tests (8 state, 23 parsers) including UTF-8 round-trip, DST-
  aware conversion test, malformed-input matrix.

### Changed (Initial release retroactively)
- Initial project scaffold: `pyproject.toml`, `.gitignore`, `LICENSE` (MIT),
  `README.md`, `src/time_mcp_server/` package layout, `tests/`.
- Two FastMCP tools:
  - `get_current_time(timezone?)` — current time in any IANA timezone,
    defaulting to the system local zone via `tzlocal` (UTC fallback if
    detection fails).
  - `convert_time(source_timezone, time, target_timezone)` — converts a
    24-hour `HH:MM` wall-clock time between two IANA zones, anchored to the
    source zone's current date.
- DST spring-forward gap detection in `convert_time`: nonexistent wall-clock
  times (e.g., `02:30` on a US spring-forward day) return an error rather
  than silently producing the pre-transition offset.
- 15 unit tests covering valid/invalid timezones, DST gap, DST fall-back
  ambiguity (fold=0 acceptance), summer vs. winter `is_dst` flag, and naive-
  datetime rejection in `_zone_snapshot`.
