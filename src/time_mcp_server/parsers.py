"""Parsers for natural-language durations and alarm timestamps.

`parse_duration` matches the syntax used by Claude Code's `/loop`
(`5m`, `1h30m`, `90s`, `1d2h`) so authors don't have to switch dialects.
`parse_alarm_time` wraps `dateparser` to accept relative phrases
(`in 4 hours`, `tomorrow at 9am`) and absolute timestamps. Naive absolute
strings are interpreted as UTC by default for environment-independent
behavior; pass ``tz_name`` to interpret them in a specific zone instead.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

import dateparser

_DURATION_RE = re.compile(
    r"^\s*(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$"
)
_BARE_NUMBER_RE = re.compile(r"^\s*\d+\s*$")


def parse_duration(s: str) -> int:
    """Parse a duration string into seconds.

    Accepts ``1d``, ``2h``, ``30m``, ``45s`` and any concatenation thereof in
    that order (``1d2h3m4s``). A bare integer is interpreted as seconds.
    Raises ``ValueError`` on empty input, unknown units, decimals, or
    out-of-order components.
    """
    if not s or not s.strip():
        raise ValueError("Duration is empty")

    if _BARE_NUMBER_RE.match(s):
        return int(s.strip())

    match = _DURATION_RE.match(s)
    # Load-bearing: the regex matches an all-empty input (every group optional),
    # so the all-None check is what enforces "at least one component required".
    if not match or not any(match.groups()):
        raise ValueError(
            f"Malformed duration {s!r}; expected forms like '5m', '1h30m', '90s', '2d'"
        )
    days, hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds


def parse_alarm_time(s: str, tz_name: Optional[str] = None) -> datetime:
    """Parse a natural-language alarm timestamp into a tz-aware datetime.

    Accepts relative phrases (``in 4 hours``, ``tomorrow at 9am``) and
    absolute timestamps (``2030-06-15 14:30:00``). The output is always
    timezone-aware. Naive absolute strings are interpreted in *tz_name*
    if given, otherwise UTC — making behavior deterministic across
    environments rather than dependent on the host's local zone.

    Raises ``ValueError`` on unparseable input.
    """
    parsed = dateparser.parse(
        s,
        settings={
            "PREFER_DATES_FROM": "future",
            "RETURN_AS_TIMEZONE_AWARE": True,
            "TIMEZONE": tz_name or "UTC",
        },
    )
    if parsed is None:
        raise ValueError(f"Could not parse alarm time: {s!r}")
    return parsed
