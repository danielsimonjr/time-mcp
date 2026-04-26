"""FastMCP server providing time, timezone, timer, stopwatch, and alarm tools."""

import asyncio
import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from time_mcp_server.parsers import parse_duration
from time_mcp_server.state import load_state, make_id, save_state

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


class EmptyInput(BaseModel):
    pass


class TimerStartInput(BaseModel):
    duration: str = Field(
        ...,
        description=(
            "Countdown duration. Accepts '5m', '1h30m', '90s', '1d2h3m4s', "
            "or a bare integer (seconds)."
        ),
    )
    label: Optional[str] = Field(None, description="Optional human label for the timer.")


class TimerIdInput(BaseModel):
    timer_id: str = Field(..., description="8-char timer ID returned by timer_start")


class StopwatchStartInput(BaseModel):
    label: Optional[str] = Field(None, description="Optional human label for the stopwatch.")


class StopwatchIdInput(BaseModel):
    stopwatch_id: str = Field(..., description="8-char stopwatch ID returned by stopwatch_start")


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


# ── Timer Tools ───────────────────────────────────────────────────────────────


def _timer_view(timer_id: str, record: dict, now: datetime) -> dict:
    """Render a stored timer record as a status payload.

    Status is computed (never stored) so that time passing doesn't require
    a state mutation.
    """
    expires_at = datetime.fromisoformat(record["expires_at"])
    if record.get("cancelled_at"):
        status = "cancelled"
        remaining = 0
    elif now >= expires_at:
        status = "expired"
        remaining = int((expires_at - now).total_seconds())
    else:
        status = "running"
        remaining = int((expires_at - now).total_seconds())
    return {
        "timer_id": timer_id,
        "label": record.get("label"),
        "started_at": record["started_at"],
        "expires_at": record["expires_at"],
        "cancelled_at": record.get("cancelled_at"),
        "status": status,
        "remaining_seconds": remaining,
    }


@mcp.tool()
async def timer_start(params: TimerStartInput) -> str:
    """Start a countdown timer that fires after *duration* elapses.

    Returns the new timer's ID. Status is queryable via timer_check or
    timer_list — there is no automatic notification on expiry, so pair with
    Claude Code's `/loop` to poll if you want to react when it fires.
    """

    def _run():
        try:
            seconds = parse_duration(params.duration)
        except ValueError as exc:
            return _err(str(exc))

        now = datetime.now(timezone.utc)
        timer_id = make_id()
        record = {
            "label": params.label,
            "started_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=seconds)).isoformat(),
            "cancelled_at": None,
        }
        state = load_state()
        state["timers"][timer_id] = record
        save_state(state)
        return json.dumps(
            {
                "status": "ok",
                "timer_id": timer_id,
                "label": params.label,
                "duration_seconds": seconds,
                "expires_at": record["expires_at"],
            }
        )

    return await asyncio.to_thread(_run)


@mcp.tool()
async def timer_list(params: EmptyInput) -> str:
    """List all timers with their computed status and remaining time."""

    def _run():
        state = load_state()
        now = datetime.now(timezone.utc)
        timers = [
            _timer_view(tid, rec, now) for tid, rec in state["timers"].items()
        ]
        return json.dumps({"status": "ok", "count": len(timers), "timers": timers})

    return await asyncio.to_thread(_run)


@mcp.tool()
async def timer_check(params: TimerIdInput) -> str:
    """Look up a single timer by ID."""

    def _run():
        state = load_state()
        record = state["timers"].get(params.timer_id)
        if record is None:
            return _err(f"Timer {params.timer_id!r} not found")
        now = datetime.now(timezone.utc)
        return json.dumps({"status": "ok", "timer": _timer_view(params.timer_id, record, now)})

    return await asyncio.to_thread(_run)


@mcp.tool()
async def timer_cancel(params: TimerIdInput) -> str:
    """Cancel a timer. Idempotent — cancelling an already-cancelled timer is OK."""

    def _run():
        state = load_state()
        record = state["timers"].get(params.timer_id)
        if record is None:
            return _err(f"Timer {params.timer_id!r} not found")
        if record.get("cancelled_at") is None:
            record["cancelled_at"] = datetime.now(timezone.utc).isoformat()
            save_state(state)
        now = datetime.now(timezone.utc)
        return json.dumps(
            {"status": "ok", "timer": _timer_view(params.timer_id, record, now)}
        )

    return await asyncio.to_thread(_run)


# ── Stopwatch Tools ───────────────────────────────────────────────────────────


def _stopwatch_view(stopwatch_id: str, record: dict, now: datetime) -> dict:
    """Render a stored stopwatch record as a status payload (computed fields)."""
    started_at = datetime.fromisoformat(record["started_at"])
    stopped_at_str = record.get("stopped_at")
    if stopped_at_str:
        stopped_at = datetime.fromisoformat(stopped_at_str)
        elapsed = int((stopped_at - started_at).total_seconds())
        status = "stopped"
    else:
        elapsed = int((now - started_at).total_seconds())
        status = "running"
    return {
        "stopwatch_id": stopwatch_id,
        "label": record.get("label"),
        "started_at": record["started_at"],
        "stopped_at": stopped_at_str,
        "status": status,
        "elapsed_seconds": elapsed,
    }


@mcp.tool()
async def stopwatch_start(params: StopwatchStartInput) -> str:
    """Start a stopwatch counting up from now. Returns the new stopwatch's ID."""

    def _run():
        now = datetime.now(timezone.utc)
        sw_id = make_id()
        state = load_state()
        state["stopwatches"][sw_id] = {
            "label": params.label,
            "started_at": now.isoformat(),
            "stopped_at": None,
        }
        save_state(state)
        return json.dumps(
            {"status": "ok", "stopwatch_id": sw_id, "label": params.label}
        )

    return await asyncio.to_thread(_run)


@mcp.tool()
async def stopwatch_stop(params: StopwatchIdInput) -> str:
    """Stop a running stopwatch and return the final elapsed time.

    Not idempotent — stopping an already-stopped stopwatch is a usage error.
    """

    def _run():
        state = load_state()
        record = state["stopwatches"].get(params.stopwatch_id)
        if record is None:
            return _err(f"Stopwatch {params.stopwatch_id!r} not found")
        if record.get("stopped_at") is not None:
            return _err(f"Stopwatch {params.stopwatch_id!r} is already stopped")
        now = datetime.now(timezone.utc)
        record["stopped_at"] = now.isoformat()
        save_state(state)
        return json.dumps(
            {"status": "ok", "stopwatch": _stopwatch_view(params.stopwatch_id, record, now)}
        )

    return await asyncio.to_thread(_run)


@mcp.tool()
async def stopwatch_check(params: StopwatchIdInput) -> str:
    """Look up a single stopwatch's elapsed time without stopping it."""

    def _run():
        state = load_state()
        record = state["stopwatches"].get(params.stopwatch_id)
        if record is None:
            return _err(f"Stopwatch {params.stopwatch_id!r} not found")
        now = datetime.now(timezone.utc)
        return json.dumps(
            {"status": "ok", "stopwatch": _stopwatch_view(params.stopwatch_id, record, now)}
        )

    return await asyncio.to_thread(_run)


@mcp.tool()
async def stopwatch_list(params: EmptyInput) -> str:
    """List all stopwatches with their computed status and elapsed time."""

    def _run():
        state = load_state()
        now = datetime.now(timezone.utc)
        watches = [
            _stopwatch_view(sid, rec, now) for sid, rec in state["stopwatches"].items()
        ]
        return json.dumps(
            {"status": "ok", "count": len(watches), "stopwatches": watches}
        )

    return await asyncio.to_thread(_run)


# ── Entry Point ───────────────────────────────────────────────────────────────


def main() -> None:
    """Run the FastMCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
