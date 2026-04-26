"""Claude Code UserPromptSubmit hook: inject notifications for expired timers
and fired alarms into the session.

Configure in ``~/.claude/settings.json``:

    {
      "hooks": {
        "UserPromptSubmit": [
          {
            "command": "C:/Users/<you>/.venvs/time-mcp/Scripts/python.exe -m time_mcp_server.notify_hook"
          }
        ]
      }
    }

The hook drains stdin (the prompt JSON Claude Code sends), reads
``~/.time-mcp/state.json``, and emits one ``additionalContext`` payload for
each timer that has expired or alarm that has fired without being notified.
The ``notified_at`` field is then set on each, so the next run is silent
unless something new fires.

Designed to be cheap: imports only ``time_mcp_server.state`` (stdlib
underneath), no FastMCP / pydantic / dateparser load at hook startup.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

from time_mcp_server.state import load_state, save_state


def _format_seconds(s: int) -> str:
    """Compact human format: 4m, 2h, 1d. Always positive (caller passes |delta|)."""
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def _label_part(label) -> str:
    return f" '{label}'" if label else ""


def collect_notifications(state: dict, now: datetime) -> tuple[list[str], dict]:
    """Find newly-expired timers + fired alarms; return notification lines and
    a mutated state dict (records updated with ``notified_at``).

    A record qualifies if:
      - cancelled_at is null/missing, AND
      - notified_at is null/missing, AND
      - the threshold time has passed (expires_at for timers, fires_at for alarms).
    """
    lines: list[str] = []
    now_iso = now.isoformat()

    for timer_id, record in state.get("timers", {}).items():
        if record.get("cancelled_at") or record.get("notified_at"):
            continue
        expires_at = datetime.fromisoformat(record["expires_at"])
        if now < expires_at:
            continue
        ago = _format_seconds(int((now - expires_at).total_seconds()))
        lines.append(
            f"\U0001f514 Timer{_label_part(record.get('label'))} ({timer_id}) expired {ago} ago"
        )
        record["notified_at"] = now_iso

    for alarm_id, record in state.get("alarms", {}).items():
        if record.get("cancelled_at") or record.get("notified_at"):
            continue
        fires_at = datetime.fromisoformat(record["fires_at"])
        if now < fires_at:
            continue
        ago = _format_seconds(int((now - fires_at).total_seconds()))
        lines.append(
            f"\U0001f514 Alarm{_label_part(record.get('label'))} ({alarm_id}) fired {ago} ago"
        )
        record["notified_at"] = now_iso

    return lines, state


def main() -> int:
    """Hook entry point. Always returns 0 — never break a user prompt."""
    # Drain the JSON Claude Code sends on stdin; we don't use it but shouldn't
    # leave the pipe unread.
    try:
        sys.stdin.read()
    except Exception:
        pass

    try:
        state = load_state()
    except Exception:
        return 0

    lines, mutated = collect_notifications(state, datetime.now(timezone.utc))
    if not lines:
        return 0

    try:
        save_state(mutated)
    except Exception:
        # If the save fails, still emit notifications this turn; we'll
        # duplicate next turn rather than silently drop.
        pass

    payload = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n".join(lines),
        }
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
