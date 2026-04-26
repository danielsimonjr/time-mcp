"""Tests for duration and datetime parsers."""

from datetime import datetime, timezone

import pytest

from time_mcp_server.parsers import parse_alarm_time, parse_duration


# ── parse_duration ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "input_str,expected_seconds",
    [
        ("30s", 30),
        ("5m", 300),
        ("1h", 3600),
        ("2d", 172_800),
        ("1h30m", 5400),
        ("90m", 5400),
        ("1d2h3m4s", 93_784),
        ("0s", 0),
        ("60", 60),  # bare number → seconds
    ],
)
def test_parse_duration_valid(input_str, expected_seconds):
    assert parse_duration(input_str) == expected_seconds


@pytest.mark.parametrize(
    "bad_input",
    [
        "",
        "abc",
        "5x",
        "-5m",
        "1.5h",
        "h",
        "5m3",  # trailing digits without unit
        "3s1d",  # out of order (s before d)
        "1m1h",  # out of order (m before h)
    ],
)
def test_parse_duration_rejects_malformed(bad_input):
    with pytest.raises(ValueError):
        parse_duration(bad_input)


# ── parse_alarm_time ───────────────────────────────────────────────────────────


def test_parse_alarm_time_relative_in_four_hours():
    """'in 4 hours' is roughly four hours from now (within 5s tolerance)."""
    before = datetime.now(timezone.utc)
    result = parse_alarm_time("in 4 hours")
    after = datetime.now(timezone.utc)
    assert result.tzinfo is not None
    delta_low = (result - before).total_seconds()
    delta_high = (result - after).total_seconds()
    assert 4 * 3600 - 5 <= delta_low <= 4 * 3600 + 5
    assert 4 * 3600 - 5 <= delta_high <= 4 * 3600 + 5


def test_parse_alarm_time_absolute_iso_string_defaults_to_utc():
    """A naive ISO string is interpreted as UTC for environment-independent behavior."""
    result = parse_alarm_time("2030-06-15 14:30:00")
    assert result.year == 2030
    assert result.month == 6
    assert result.day == 15
    assert result.hour == 14
    assert result.minute == 30
    assert result.tzinfo is not None
    assert result.utcoffset().total_seconds() == 0


def test_parse_alarm_time_absolute_with_explicit_tz():
    """Caller-supplied tz_name interprets the naive string in that zone."""
    result = parse_alarm_time("2030-06-15 14:30:00", tz_name="America/New_York")
    # Eastern in June is EDT, UTC-4: 14:30 EDT == 18:30 UTC
    assert result.year == 2030
    assert result.month == 6
    assert result.day == 15
    assert result.hour == 14
    assert result.minute == 30
    assert result.utcoffset().total_seconds() == -4 * 3600


def test_parse_alarm_time_returns_utc_aware():
    """Output is always tz-aware (no naive datetimes)."""
    result = parse_alarm_time("tomorrow at 9am")
    assert result.tzinfo is not None


def test_parse_alarm_time_rejects_garbage():
    with pytest.raises(ValueError):
        parse_alarm_time("not a real time at all")
