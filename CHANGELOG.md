# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
