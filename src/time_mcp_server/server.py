"""FastMCP server providing time, timezone, timer, stopwatch, and alarm tools.

Currently implemented (initial release):
  get_current_time   — current time in any IANA timezone
  convert_time       — convert HH:MM between two IANA timezones

Subsequent commits add: state persistence + parsers, then timer / stopwatch /
alarm lifecycles.
"""

import asyncio
import json
import logging
import sys
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("time_mcp")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _resolve_timezone(name: Optional[str]) -> ZoneInfo:
    """Return a ZoneInfo for *name*, or for the system local zone when None.

    Raises ZoneInfoNotFoundError if *name* is not a valid IANA name.
    Falls back to UTC if the system zone cannot be detected (e.g., minimal
    Windows configs without ``tzlocal`` data).
    """
    if name is None:
        try:
            from tzlocal import get_localzone_name

            name = get_localzone_name() or "UTC"
        except Exception as exc:  # pragma: no cover — defensive
            log.warning("tzlocal failed (%s); falling back to UTC", exc)
            name = "UTC"
    return ZoneInfo(name)


def _err(message: str) -> str:
    """Standard error payload (JSON-encoded)."""
    return json.dumps({"status": "error", "error": message})


def _err_dict(message: str) -> dict:
    """Standard error payload (dict). Use when a helper still composes JSON later."""
    return {"status": "error", "error": message}


def _zone_snapshot(when: datetime) -> dict:
    """Render a timezone-aware datetime as an ISO + HH:MM:SS + DST payload dict."""
    if when.tzinfo is None:
        raise ValueError("_zone_snapshot requires a timezone-aware datetime")
    return {
        "timezone": str(when.tzinfo),
        "datetime": when.isoformat(timespec="seconds"),
        "time": when.strftime("%H:%M:%S"),
        "is_dst": bool(when.dst()),
    }


def _convert_wallclock(
    time_str: str,
    src_zone: ZoneInfo,
    dst_zone: ZoneInfo,
    on_date: date,
) -> dict:
    """Convert HH:MM on *on_date* from src_zone to dst_zone.

    Always returns a dict with a ``status`` key — ``"ok"`` (with source/target/
    offset_hours) or ``"error"`` (with an ``error`` message). Detects DST
    spring-forward gaps via UTC round-trip and falls back to fold=0 on
    ambiguous fall-back times — matches what a user typing "01:30" usually
    means without surprising them.
    """
    try:
        hour, minute = (int(p) for p in time_str.split(":"))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("hour/minute out of range")
    except ValueError:
        return _err_dict(
            f"Malformed time {time_str!r}; expected 24-hour HH:MM (e.g., '14:30')"
        )

    source_dt = datetime(
        on_date.year, on_date.month, on_date.day, hour, minute, tzinfo=src_zone
    )
    roundtrip = source_dt.astimezone(timezone.utc).astimezone(src_zone)
    if (roundtrip.hour, roundtrip.minute) != (hour, minute):
        return _err_dict(
            f"Time {time_str!r} does not exist in {src_zone} on {on_date.isoformat()} "
            "(DST spring-forward gap)"
        )

    target_dt = source_dt.astimezone(dst_zone)
    offset_hours = (
        target_dt.utcoffset().total_seconds() - source_dt.utcoffset().total_seconds()
    ) / 3600

    return {
        "status": "ok",
        "source": _zone_snapshot(source_dt),
        "target": _zone_snapshot(target_dt),
        "offset_hours": offset_hours,
    }


# ── FastMCP ───────────────────────────────────────────────────────────────────

mcp = FastMCP("time-mcp")


# ── Input Models ──────────────────────────────────────────────────────────────


class GetCurrentTimeInput(BaseModel):
    timezone: Optional[str] = Field(
        None,
        description=(
            "IANA timezone name (e.g., 'America/New_York', 'UTC', 'Europe/London'). "
            "Omit to use the system local zone."
        ),
    )


class ConvertTimeInput(BaseModel):
    source_timezone: str = Field(..., description="Source IANA timezone name")
    time: str = Field(..., description="Time in 24-hour HH:MM format")
    target_timezone: str = Field(..., description="Target IANA timezone name")


# ── Time & Timezone Tools ─────────────────────────────────────────────────────


@mcp.tool()
async def get_current_time(params: GetCurrentTimeInput) -> str:
    """Return the current time in the requested timezone (or system local zone)."""

    def _run():
        try:
            zone = _resolve_timezone(params.timezone)
        except ZoneInfoNotFoundError:
            return _err(f"Unknown IANA timezone: {params.timezone!r}")

        now = datetime.now(zone)
        payload = {"status": "ok", **_zone_snapshot(now)}
        return json.dumps(payload)

    return await asyncio.to_thread(_run)


@mcp.tool()
async def convert_time(params: ConvertTimeInput) -> str:
    """Convert a HH:MM wall-clock time from one IANA timezone to another.

    The conversion is anchored to today's date in the source zone, so DST
    transitions are interpreted with the current rules. Times that don't
    exist in the source zone (DST spring-forward gap) are rejected.
    """

    def _run():
        try:
            src_zone = _resolve_timezone(params.source_timezone)
        except ZoneInfoNotFoundError:
            return _err(f"Unknown source timezone: {params.source_timezone!r}")
        try:
            dst_zone = _resolve_timezone(params.target_timezone)
        except ZoneInfoNotFoundError:
            return _err(f"Unknown target timezone: {params.target_timezone!r}")

        today = datetime.now(src_zone).date()
        return json.dumps(_convert_wallclock(params.time, src_zone, dst_zone, today))

    return await asyncio.to_thread(_run)


# ── Entry Point ───────────────────────────────────────────────────────────────


def main() -> None:
    """Run the FastMCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
