"""Tests for the persistence layer."""

import json
from pathlib import Path

import pytest

from time_mcp_server.state import (
    DEFAULT_STATE,
    load_state,
    make_id,
    save_state,
)


def test_load_state_returns_default_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))
    state = load_state()
    assert state == DEFAULT_STATE
    assert "timers" in state
    assert "stopwatches" in state
    assert "alarms" in state


def test_save_then_load_round_trips(tmp_path, monkeypatch):
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))
    state = {"timers": {"abc12345": {"label": "test"}}, "stopwatches": {}, "alarms": {}}
    save_state(state)
    loaded = load_state()
    assert loaded == state


def test_save_state_creates_state_dir(tmp_path, monkeypatch):
    target_dir = tmp_path / "nested" / "time-mcp"
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(target_dir))
    save_state(DEFAULT_STATE)
    assert target_dir.exists()
    assert (target_dir / "state.json").exists()


def test_save_state_uses_atomic_write(tmp_path, monkeypatch):
    """The saved file appears whole or not at all — no partial-write artifact."""
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))
    save_state(DEFAULT_STATE)
    files = list(tmp_path.iterdir())
    # Only state.json should remain — no leftover .tmp file from atomic rename
    assert [f.name for f in files] == ["state.json"]
    parsed = json.loads(Path(tmp_path / "state.json").read_text())
    assert parsed == DEFAULT_STATE


def test_make_id_returns_8_chars():
    id1 = make_id()
    assert len(id1) == 8
    assert id1.isalnum() or all(c.isalnum() or c in "-_" for c in id1)


def test_make_id_is_unique_across_many_calls():
    # token_urlsafe(6) is base64url over 6 bytes ≈ 48 bits of entropy;
    # 1000 IDs should collide effectively never.
    ids = {make_id() for _ in range(1000)}
    assert len(ids) == 1000


def test_save_and_load_round_trip_unicode_label(tmp_path, monkeypatch):
    """Non-ASCII labels (emoji, accented chars) survive UTF-8 round-trip."""
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))
    state = {
        "timers": {"abc12345": {"label": "café timer ⏰"}},
        "stopwatches": {},
        "alarms": {},
    }
    save_state(state)
    loaded = load_state()
    assert loaded["timers"]["abc12345"]["label"] == "café timer ⏰"


def test_load_state_repairs_missing_keys(tmp_path, monkeypatch):
    """An older state file lacking 'alarms' key still loads with default."""
    monkeypatch.setenv("TIME_MCP_STATE_DIR", str(tmp_path))
    incomplete = {"timers": {"x": {}}}
    (tmp_path / "state.json").write_text(json.dumps(incomplete))
    state = load_state()
    assert state["timers"] == {"x": {}}
    assert state["stopwatches"] == {}
    assert state["alarms"] == {}
