"""Tests for the notify_hook script (Claude Code UserPromptSubmit hook)."""

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from time_mcp_server.notify_hook import collect_notifications
from time_mcp_server.state import load_state, save_state


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── collect_notifications ──────────────────────────────────────────────────────


def test_collect_notifications_empty_state():
    state = {"timers": {}, "stopwatches": {}, "alarms": {}}
    lines, mutated = collect_notifications(state, _now())
    assert lines == []
    assert mutated == state


def test_collect_notifications_finds_expired_timer():
    now = _now()
    state = {
        "timers": {
            "abc12345": {
                "label": "deploy check",
                "started_at": (now - timedelta(seconds=600)).isoformat(),
                "expires_at": (now - timedelta(seconds=120)).isoformat(),
                "cancelled_at": None,
            }
        },
        "stopwatches": {},
        "alarms": {},
    }
    lines, mutated = collect_notifications(state, now)
    assert len(lines) == 1
    assert "Timer" in lines[0]
    assert "deploy check" in lines[0]
    assert "abc12345" in lines[0]
    assert "🔔" in lines[0]
    # Mutation: notified_at written
    assert mutated["timers"]["abc12345"]["notified_at"] is not None


def test_collect_notifications_finds_fired_alarm():
    now = _now()
    state = {
        "timers": {},
        "stopwatches": {},
        "alarms": {
            "alm99999": {
                "label": "meeting prep",
                "fires_at": (now - timedelta(seconds=30)).isoformat(),
                "cancelled_at": None,
            }
        },
    }
    lines, mutated = collect_notifications(state, now)
    assert len(lines) == 1
    assert "Alarm" in lines[0]
    assert "meeting prep" in lines[0]
    assert mutated["alarms"]["alm99999"]["notified_at"] is not None


def test_collect_notifications_skips_cancelled():
    now = _now()
    state = {
        "timers": {
            "cancelled1": {
                "label": "cancelled",
                "started_at": (now - timedelta(seconds=100)).isoformat(),
                "expires_at": (now - timedelta(seconds=10)).isoformat(),
                "cancelled_at": (now - timedelta(seconds=50)).isoformat(),
            }
        },
        "stopwatches": {},
        "alarms": {
            "cancelled2": {
                "label": None,
                "fires_at": (now - timedelta(seconds=5)).isoformat(),
                "cancelled_at": now.isoformat(),
            }
        },
    }
    lines, _ = collect_notifications(state, now)
    assert lines == []


def test_collect_notifications_skips_already_notified():
    now = _now()
    state = {
        "timers": {
            "notified1": {
                "label": None,
                "started_at": (now - timedelta(seconds=100)).isoformat(),
                "expires_at": (now - timedelta(seconds=10)).isoformat(),
                "cancelled_at": None,
                "notified_at": (now - timedelta(seconds=8)).isoformat(),
            }
        },
        "stopwatches": {},
        "alarms": {},
    }
    lines, _ = collect_notifications(state, now)
    assert lines == []


def test_collect_notifications_skips_running_timers():
    now = _now()
    state = {
        "timers": {
            "running1": {
                "label": "active",
                "started_at": now.isoformat(),
                "expires_at": (now + timedelta(seconds=600)).isoformat(),
                "cancelled_at": None,
            }
        },
        "stopwatches": {},
        "alarms": {},
    }
    lines, _ = collect_notifications(state, now)
    assert lines == []


def test_collect_notifications_handles_unlabeled_items():
    """Unlabeled timer/alarm still produces a notification with just the ID."""
    now = _now()
    state = {
        "timers": {
            "noLabel1": {
                "label": None,
                "started_at": (now - timedelta(seconds=100)).isoformat(),
                "expires_at": (now - timedelta(seconds=5)).isoformat(),
                "cancelled_at": None,
            }
        },
        "stopwatches": {},
        "alarms": {},
    }
    lines, _ = collect_notifications(state, now)
    assert len(lines) == 1
    assert "noLabel1" in lines[0]
    # No empty-quote artifact like "Timer ''"
    assert "''" not in lines[0]


def test_collect_notifications_multiple_items():
    now = _now()
    state = {
        "timers": {
            "t1": {
                "label": "build",
                "started_at": (now - timedelta(seconds=100)).isoformat(),
                "expires_at": (now - timedelta(seconds=30)).isoformat(),
                "cancelled_at": None,
            },
        },
        "stopwatches": {},
        "alarms": {
            "a1": {
                "label": None,
                "fires_at": (now - timedelta(seconds=5)).isoformat(),
                "cancelled_at": None,
            }
        },
    }
    lines, mutated = collect_notifications(state, now)
    assert len(lines) == 2
    assert mutated["timers"]["t1"]["notified_at"]
    assert mutated["alarms"]["a1"]["notified_at"]


def test_collect_notifications_treats_missing_notified_at_as_pending():
    """Existing records without notified_at field still notify on first check."""
    now = _now()
    state = {
        "timers": {
            "old1": {
                "label": "legacy",
                "started_at": (now - timedelta(seconds=100)).isoformat(),
                "expires_at": (now - timedelta(seconds=10)).isoformat(),
                "cancelled_at": None,
                # no "notified_at" key at all
            }
        },
        "stopwatches": {},
        "alarms": {},
    }
    lines, mutated = collect_notifications(state, now)
    assert len(lines) == 1
    assert mutated["timers"]["old1"]["notified_at"] is not None


# ── main() smoke tests via subprocess ──────────────────────────────────────────


def _run_hook(state_dir: Path) -> subprocess.CompletedProcess:
    """Run the hook script as a subprocess with stdin piped (mimics CC behavior)."""
    return subprocess.run(
        [sys.executable, "-m", "time_mcp_server.notify_hook"],
        input='{"prompt": "test"}',
        capture_output=True,
        text=True,
        env={"TIME_MCP_STATE_DIR": str(state_dir), "PATH": __import__("os").environ.get("PATH", "")},
    )


def test_hook_main_no_state_exits_clean(tmp_path):
    """No state.json on disk → exit 0, no output."""
    result = _run_hook(tmp_path)
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_hook_main_emits_json_when_expired_timer_present(tmp_path):
    """An expired timer triggers the JSON additionalContext payload."""
    now = datetime.now(timezone.utc)
    save_state(
        {
            "timers": {
                "smoke111": {
                    "label": "test",
                    "started_at": (now - timedelta(seconds=100)).isoformat(),
                    "expires_at": (now - timedelta(seconds=10)).isoformat(),
                    "cancelled_at": None,
                }
            },
            "stopwatches": {},
            "alarms": {},
        }
    )
    result = _run_hook(tmp_path)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    assert "Timer" in payload["hookSpecificOutput"]["additionalContext"]
    assert "smoke111" in payload["hookSpecificOutput"]["additionalContext"]
    # Persistence: notified_at written, second run should produce no output
    second = _run_hook(tmp_path)
    assert second.stdout.strip() == ""
