"""Tests for stopwatch (count-up) tools."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from time_mcp_server.server import (
    EmptyInput,
    StopwatchIdInput,
    StopwatchStartInput,
    stopwatch_check,
    stopwatch_list,
    stopwatch_start,
    stopwatch_stop,
)
from time_mcp_server.state import load_state, save_state


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))


# ── stopwatch_start ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stopwatch_start_returns_id_and_persists():
    result = await stopwatch_start(StopwatchStartInput(label="build"))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert len(data["stopwatch_id"]) == 8
    state = load_state()
    assert data["stopwatch_id"] in state["stopwatches"]
    assert state["stopwatches"][data["stopwatch_id"]]["stopped_at"] is None


@pytest.mark.asyncio
async def test_stopwatch_start_without_label():
    result = await stopwatch_start(StopwatchStartInput(label=None))
    data = json.loads(result)
    assert data["status"] == "ok"


# ── stopwatch_check ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stopwatch_check_running_returns_elapsed():
    """Inject a stopwatch started 5 seconds ago — elapsed should be ≥ 5."""
    state = load_state()
    state["stopwatches"]["sw-running"] = {
        "label": "active",
        "started_at": (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(),
        "stopped_at": None,
    }
    save_state(state)
    result = await stopwatch_check(StopwatchIdInput(stopwatch_id="sw-running"))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["stopwatch"]["status"] == "running"
    assert data["stopwatch"]["elapsed_seconds"] >= 5


@pytest.mark.asyncio
async def test_stopwatch_check_stopped_returns_final_elapsed():
    now = datetime.now(timezone.utc)
    state = load_state()
    state["stopwatches"]["sw-stopped"] = {
        "label": None,
        "started_at": (now - timedelta(seconds=120)).isoformat(),
        "stopped_at": (now - timedelta(seconds=10)).isoformat(),
    }
    save_state(state)
    result = await stopwatch_check(StopwatchIdInput(stopwatch_id="sw-stopped"))
    data = json.loads(result)
    assert data["stopwatch"]["status"] == "stopped"
    # Stopped 10s ago, ran for 110s
    assert 109 <= data["stopwatch"]["elapsed_seconds"] <= 111


@pytest.mark.asyncio
async def test_stopwatch_check_not_found_returns_error():
    result = await stopwatch_check(StopwatchIdInput(stopwatch_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"


# ── stopwatch_stop ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stopwatch_stop_running_returns_final_elapsed():
    started = await stopwatch_start(StopwatchStartInput(label=None))
    sw_id = json.loads(started)["stopwatch_id"]
    result = await stopwatch_stop(StopwatchIdInput(stopwatch_id=sw_id))
    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["stopwatch"]["status"] == "stopped"
    assert data["stopwatch"]["elapsed_seconds"] >= 0


@pytest.mark.asyncio
async def test_stopwatch_stop_already_stopped_is_error():
    """Stopping a stopped stopwatch is a usage error (not idempotent)."""
    started = await stopwatch_start(StopwatchStartInput(label=None))
    sw_id = json.loads(started)["stopwatch_id"]
    await stopwatch_stop(StopwatchIdInput(stopwatch_id=sw_id))
    second = await stopwatch_stop(StopwatchIdInput(stopwatch_id=sw_id))
    data = json.loads(second)
    assert data["status"] == "error"
    assert "already" in data["error"].lower() or "stopped" in data["error"].lower()


@pytest.mark.asyncio
async def test_stopwatch_stop_not_found_returns_error():
    result = await stopwatch_stop(StopwatchIdInput(stopwatch_id="ghost123"))
    data = json.loads(result)
    assert data["status"] == "error"


# ── stopwatch_list ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stopwatch_list_empty():
    result = await stopwatch_list(EmptyInput())
    data = json.loads(result)
    assert data["count"] == 0
    assert data["stopwatches"] == []


@pytest.mark.asyncio
async def test_stopwatch_list_mixed_running_and_stopped():
    now = datetime.now(timezone.utc)
    state = load_state()
    state["stopwatches"]["a"] = {
        "label": "r",
        "started_at": (now - timedelta(seconds=2)).isoformat(),
        "stopped_at": None,
    }
    state["stopwatches"]["b"] = {
        "label": "s",
        "started_at": (now - timedelta(seconds=100)).isoformat(),
        "stopped_at": (now - timedelta(seconds=50)).isoformat(),
    }
    save_state(state)
    result = await stopwatch_list(EmptyInput())
    data = json.loads(result)
    assert data["count"] == 2
    by_id = {s["stopwatch_id"]: s for s in data["stopwatches"]}
    assert by_id["a"]["status"] == "running"
    assert by_id["b"]["status"] == "stopped"
    # b stopped at -50s with started_at -100s → elapsed = 50s
    assert 49 <= by_id["b"]["elapsed_seconds"] <= 51
