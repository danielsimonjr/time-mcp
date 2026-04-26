"""Tests for time/timezone tools."""

import json
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from time_mcp_server.server import (
    ConvertTimeInput,
    GetCurrentTimeInput,
    _convert_wallclock,
    _zone_snapshot,
    convert_time,
    get_current_time,
)


# ── get_current_time ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_current_time_returns_ok_with_iso_datetime():
    result = await get_current_time(GetCurrentTimeInput(timezone="UTC"))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["timezone"] == "UTC"
    parsed = datetime.fromisoformat(data["datetime"])
    assert parsed.tzinfo is not None
    assert re.fullmatch(r"\d{2}:\d{2}:\d{2}", data["time"])


@pytest.mark.asyncio
async def test_get_current_time_includes_is_dst_flag():
    """is_dst must be a bool — UTC is never DST."""
    result = await get_current_time(GetCurrentTimeInput(timezone="UTC"))
    data = json.loads(result)
    assert data["is_dst"] is False


@pytest.mark.asyncio
async def test_get_current_time_falls_back_when_timezone_omitted():
    result = await get_current_time(GetCurrentTimeInput(timezone=None))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["timezone"]  # non-empty (system zone or UTC fallback)


@pytest.mark.asyncio
async def test_get_current_time_invalid_timezone_returns_error():
    result = await get_current_time(GetCurrentTimeInput(timezone="Not/A_Real_Zone"))
    data = json.loads(result)
    assert data["status"] == "error"
    assert "timezone" in data["error"].lower()


# ── convert_time ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_convert_time_utc_to_new_york():
    """Noon UTC → 7 or 8 AM in NY depending on DST."""
    result = await convert_time(
        ConvertTimeInput(
            source_timezone="UTC",
            time="12:00",
            target_timezone="America/New_York",
        )
    )
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["source"]["timezone"] == "UTC"
    assert data["target"]["timezone"] == "America/New_York"
    target_hour = int(data["target"]["time"].split(":")[0])
    assert target_hour in (7, 8)


@pytest.mark.asyncio
async def test_convert_time_includes_is_dst_for_both_sides():
    result = await convert_time(
        ConvertTimeInput(
            source_timezone="UTC",
            time="00:00",
            target_timezone="Asia/Tokyo",
        )
    )
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["source"]["is_dst"] is False
    assert data["target"]["is_dst"] is False  # Tokyo doesn't observe DST


@pytest.mark.asyncio
async def test_convert_time_malformed_time_returns_error():
    result = await convert_time(
        ConvertTimeInput(
            source_timezone="UTC",
            time="not-a-time",
            target_timezone="UTC",
        )
    )
    data = json.loads(result)
    assert data["status"] == "error"


@pytest.mark.asyncio
async def test_convert_time_invalid_target_timezone_returns_error():
    result = await convert_time(
        ConvertTimeInput(
            source_timezone="UTC",
            time="12:00",
            target_timezone="Bogus/Zone",
        )
    )
    data = json.loads(result)
    assert data["status"] == "error"


@pytest.mark.asyncio
async def test_convert_time_invalid_source_timezone_returns_error():
    result = await convert_time(
        ConvertTimeInput(
            source_timezone="Bogus/Zone",
            time="12:00",
            target_timezone="UTC",
        )
    )
    data = json.loads(result)
    assert data["status"] == "error"
    assert "source" in data["error"].lower()


# ── _convert_wallclock helper (date-pinned tests for DST behavior) ─────────────


def test_convert_wallclock_detects_dst_spring_forward_gap():
    """02:30 on 2026-03-08 doesn't exist in America/New_York."""
    ny = ZoneInfo("America/New_York")
    result = _convert_wallclock("02:30", ny, ZoneInfo("UTC"), date(2026, 3, 8))
    assert result["status"] == "error"
    assert "gap" in result["error"].lower() or "exist" in result["error"].lower()


def test_convert_wallclock_handles_dst_fall_back_without_error():
    """01:30 on 2026-11-01 exists twice in America/New_York; we accept fold=0."""
    ny = ZoneInfo("America/New_York")
    result = _convert_wallclock("01:30", ny, ZoneInfo("UTC"), date(2026, 11, 1))
    assert result["status"] == "ok"
    assert "source" in result
    assert "target" in result


def test_convert_wallclock_normal_day_works():
    """Sanity baseline: noon UTC → US Eastern in summer is 8 AM EDT."""
    result = _convert_wallclock(
        "12:00",
        ZoneInfo("UTC"),
        ZoneInfo("America/New_York"),
        date(2026, 7, 1),
    )
    assert result["status"] == "ok"
    assert result["target"]["time"] == "08:00:00"
    assert result["target"]["is_dst"] is True
    assert result["source"]["is_dst"] is False


# ── _zone_snapshot helper ──────────────────────────────────────────────────────


def test_zone_snapshot_is_dst_true_for_summer_us_eastern():
    summer = datetime(2026, 7, 1, 12, 0, tzinfo=ZoneInfo("America/New_York"))
    snap = _zone_snapshot(summer)
    assert snap["is_dst"] is True
    assert snap["timezone"] == "America/New_York"


def test_zone_snapshot_is_dst_false_for_winter_us_eastern():
    winter = datetime(2026, 1, 15, 12, 0, tzinfo=ZoneInfo("America/New_York"))
    snap = _zone_snapshot(winter)
    assert snap["is_dst"] is False


def test_zone_snapshot_rejects_naive_datetime():
    naive = datetime(2026, 7, 1, 12, 0)
    with pytest.raises(ValueError, match="timezone-aware"):
        _zone_snapshot(naive)
