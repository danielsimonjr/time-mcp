"""Tests for alarm (absolute-time) tools."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from time_mcp_server.server import (
    AlarmIdInput,
    AlarmSetInput,
    EmptyInput,
    alarm_cancel,
    alarm_check,
    alarm_list,
    alarm_set,
)
from time_mcp_server.state import load_state, save_state


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))


# ── alarm_set ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_alarm_set_relative_in_4_hours_persists():
    result = await alarm_set(AlarmSetInput(when="in 4 hours", label="meeting"))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert len(data["alarm_id"]) == 8
    state = load_state()
    record = state["alarms"][data["alarm_id"]]
    assert record["label"] == "meeting"
    fires_at = datetime.fromisoformat(record["fires_at"])
    delta = (fires_at - datetime.now(timezone.utc)).total_seconds()
    assert 4 * 3600 - 60 <= delta <= 4 * 3600 + 60


@pytest.mark.asyncio
async def test_alarm_set_absolute_iso_persists():
    """An absolute ISO string sets that exact UTC fire time."""
    result = await alarm_set(AlarmSetInput(when="2030-12-31 23:59:00", label=None))
    data = json.loads(result)
    assert data["status"] == "ok"
    fires_at = datetime.fromisoformat(data["fires_at"])
    assert fires_at.year == 2030
    assert fires_at.month == 12
    assert fires_at.day == 31


@pytest.mark.asyncio
async def test_alarm_set_in_the_past_is_error():
    result = await alarm_set(AlarmSetInput(when="2000-01-01 00:00:00", label=None))
    data = json.loads(result)
    assert data["status"] == "error"
    assert "past" in data["error"].lower()


@pytest.mark.asyncio
async def test_alarm_set_garbage_returns_error():
    result = await alarm_set(AlarmSetInput(when="not-a-real-time-at-all", label=None))
    data = json.loads(result)
    assert data["status"] == "error"


# ── alarm_check ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_alarm_check_pending():
    set_result = await alarm_set(AlarmSetInput(when="in 1 hour", label=None))
    alarm_id = json.loads(set_result)["alarm_id"]
    check = await alarm_check(AlarmIdInput(alarm_id=alarm_id))
    data = json.loads(check)
    assert data["alarm"]["status"] == "pending"
    assert data["alarm"]["seconds_until_fire"] > 0


@pytest.mark.asyncio
async def test_alarm_check_fired():
    """Inject an alarm with fires_at in the past — should compute as fired."""
    state = load_state()
    state["alarms"]["fired1"] = {
        "label": "old",
        "fires_at": (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat(),
        "cancelled_at": None,
    }
    save_state(state)
    result = await alarm_check(AlarmIdInput(alarm_id="fired1"))
    data = json.loads(result)
    assert data["alarm"]["status"] == "fired"


@pytest.mark.asyncio
async def test_alarm_check_not_found_returns_error():
    result = await alarm_check(AlarmIdInput(alarm_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"


# ── alarm_cancel ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_alarm_cancel_pending_marks_cancelled():
    set_result = await alarm_set(AlarmSetInput(when="in 1 hour", label=None))
    alarm_id = json.loads(set_result)["alarm_id"]
    cancel = await alarm_cancel(AlarmIdInput(alarm_id=alarm_id))
    assert json.loads(cancel)["status"] == "ok"
    after = await alarm_check(AlarmIdInput(alarm_id=alarm_id))
    assert json.loads(after)["alarm"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_alarm_cancel_idempotent():
    set_result = await alarm_set(AlarmSetInput(when="in 1 hour", label=None))
    alarm_id = json.loads(set_result)["alarm_id"]
    await alarm_cancel(AlarmIdInput(alarm_id=alarm_id))
    second = await alarm_cancel(AlarmIdInput(alarm_id=alarm_id))
    assert json.loads(second)["status"] == "ok"


@pytest.mark.asyncio
async def test_alarm_cancel_not_found_returns_error():
    result = await alarm_cancel(AlarmIdInput(alarm_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"


# ── alarm_list ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_alarm_list_empty():
    result = await alarm_list(EmptyInput())
    data = json.loads(result)
    assert data["count"] == 0


@pytest.mark.asyncio
async def test_alarm_list_mixed_statuses():
    now = datetime.now(timezone.utc)
    state = load_state()
    state["alarms"]["pending1"] = {
        "label": None,
        "fires_at": (now + timedelta(hours=1)).isoformat(),
        "cancelled_at": None,
    }
    state["alarms"]["fired1"] = {
        "label": None,
        "fires_at": (now - timedelta(hours=1)).isoformat(),
        "cancelled_at": None,
    }
    state["alarms"]["cancelled1"] = {
        "label": None,
        "fires_at": (now + timedelta(hours=2)).isoformat(),
        "cancelled_at": now.isoformat(),
    }
    save_state(state)
    result = await alarm_list(EmptyInput())
    data = json.loads(result)
    assert data["count"] == 3
    by_id = {a["alarm_id"]: a for a in data["alarms"]}
    assert by_id["pending1"]["status"] == "pending"
    assert by_id["fired1"]["status"] == "fired"
    assert by_id["cancelled1"]["status"] == "cancelled"
