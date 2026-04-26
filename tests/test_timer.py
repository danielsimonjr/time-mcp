"""Tests for timer (countdown) tools."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from time_mcp_server.server import (
    EmptyInput,
    TimerIdInput,
    TimerStartInput,
    timer_cancel,
    timer_check,
    timer_list,
    timer_start,
)
from time_mcp_server.state import load_state, save_state


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))


# ── timer_start ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_timer_start_returns_id_and_persists():
    result = await timer_start(TimerStartInput(duration="5s", label="quick test"))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert len(data["timer_id"]) == 8
    assert data["duration_seconds"] == 5
    state = load_state()
    assert data["timer_id"] in state["timers"]
    assert state["timers"][data["timer_id"]]["label"] == "quick test"


@pytest.mark.asyncio
async def test_timer_start_complex_duration():
    result = await timer_start(TimerStartInput(duration="1h30m", label=None))
    data = json.loads(result)
    assert data["duration_seconds"] == 5400


@pytest.mark.asyncio
async def test_timer_start_malformed_duration_returns_error():
    result = await timer_start(TimerStartInput(duration="not-a-duration", label=None))
    data = json.loads(result)
    assert data["status"] == "error"


@pytest.mark.asyncio
async def test_timer_start_zero_duration_is_allowed():
    """A 0-second timer fires immediately — useful as a marker."""
    result = await timer_start(TimerStartInput(duration="0s", label=None))
    data = json.loads(result)
    assert data["status"] == "ok"


# ── timer_list ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_timer_list_empty():
    result = await timer_list(EmptyInput())
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["timers"] == []
    assert data["count"] == 0


@pytest.mark.asyncio
async def test_timer_list_shows_running_and_expired():
    """Inject a timer expired in the past and one that's still running."""
    now = datetime.now(timezone.utc)
    state = load_state()
    state["timers"]["expired1"] = {
        "label": "old",
        "started_at": (now - timedelta(seconds=10)).isoformat(),
        "expires_at": (now - timedelta(seconds=5)).isoformat(),
        "cancelled_at": None,
    }
    state["timers"]["running1"] = {
        "label": "active",
        "started_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=300)).isoformat(),
        "cancelled_at": None,
    }
    save_state(state)

    result = await timer_list(EmptyInput())
    data = json.loads(result)
    assert data["count"] == 2
    by_id = {t["timer_id"]: t for t in data["timers"]}
    assert by_id["expired1"]["status"] == "expired"
    assert by_id["expired1"]["remaining_seconds"] <= 0
    assert by_id["running1"]["status"] == "running"
    assert by_id["running1"]["remaining_seconds"] > 0


# ── timer_check ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_timer_check_running():
    started = await timer_start(TimerStartInput(duration="1h", label=None))
    timer_id = json.loads(started)["timer_id"]
    result = await timer_check(TimerIdInput(timer_id=timer_id))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["timer"]["status"] == "running"
    assert data["timer"]["remaining_seconds"] > 0


@pytest.mark.asyncio
async def test_timer_check_expired():
    now = datetime.now(timezone.utc)
    state = load_state()
    state["timers"]["t-expired"] = {
        "label": None,
        "started_at": (now - timedelta(seconds=10)).isoformat(),
        "expires_at": (now - timedelta(seconds=1)).isoformat(),
        "cancelled_at": None,
    }
    save_state(state)
    result = await timer_check(TimerIdInput(timer_id="t-expired"))
    data = json.loads(result)
    assert data["timer"]["status"] == "expired"


@pytest.mark.asyncio
async def test_timer_check_not_found_returns_error():
    result = await timer_check(TimerIdInput(timer_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"
    assert "not found" in data["error"].lower() or "ghost" in data["error"]


# ── timer_cancel ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_timer_cancel_running_marks_cancelled():
    started = await timer_start(TimerStartInput(duration="1h", label=None))
    timer_id = json.loads(started)["timer_id"]
    cancel_result = await timer_cancel(TimerIdInput(timer_id=timer_id))
    cancel_data = json.loads(cancel_result)
    assert cancel_data["status"] == "ok"

    check = await timer_check(TimerIdInput(timer_id=timer_id))
    assert json.loads(check)["timer"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_timer_cancel_idempotent():
    started = await timer_start(TimerStartInput(duration="1h", label=None))
    timer_id = json.loads(started)["timer_id"]
    await timer_cancel(TimerIdInput(timer_id=timer_id))
    second = await timer_cancel(TimerIdInput(timer_id=timer_id))
    assert json.loads(second)["status"] == "ok"


@pytest.mark.asyncio
async def test_timer_cancel_not_found_returns_error():
    result = await timer_cancel(TimerIdInput(timer_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"
