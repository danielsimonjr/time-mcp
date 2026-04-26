# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
