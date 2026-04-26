"""JSON-backed persistence for timers, stopwatches, and alarms.

Atomic writes via tempfile + os.replace, with retry-on-Windows-sharing-violation.
State directory is configurable via TIME_MCP_STATE_DIR for testing; defaults
to ~/.time-mcp/. All file I/O is UTF-8 so labels with non-ASCII characters
(emoji, accented letters) round-trip cleanly across Windows / Linux / macOS.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import time
from copy import deepcopy
from pathlib import Path

DEFAULT_STATE: dict = {"timers": {}, "stopwatches": {}, "alarms": {}}

# Windows MoveFileEx can fail with sharing violations under concurrent reads;
# brief retry preserves the atomic-rename intent without giving up.
_REPLACE_RETRIES = 3
_REPLACE_BACKOFF_SECONDS = 0.01


def _state_dir() -> Path:
    return Path(os.environ.get("TIME_MCP_STATE_DIR") or Path.home() / ".time-mcp")


def _state_file() -> Path:
    return _state_dir() / "state.json"


def make_id() -> str:
    """Return an 8-char URL-safe random ID (~48 bits of entropy via base64url)."""
    return secrets.token_urlsafe(6)


def load_state() -> dict:
    """Read state from disk, returning DEFAULT_STATE if the file is missing.

    Missing top-level keys (from older state files) are filled with the
    default empty dict — forward-compatible with future schema additions.
    Unknown top-level keys are dropped (forward-compat with newer state
    written by newer server versions).
    """
    path = _state_file()
    if not path.exists():
        return deepcopy(DEFAULT_STATE)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return deepcopy(DEFAULT_STATE)
    state = deepcopy(DEFAULT_STATE)
    state.update({k: v for k, v in loaded.items() if k in DEFAULT_STATE})
    return state


def save_state(state: dict) -> None:
    """Write state atomically: temp file in the same dir, then os.replace.

    Retries the rename briefly on Windows sharing violations so that brief
    read contention from another tool call doesn't lose the write.
    """
    directory = _state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, ensure_ascii=False)
        target = _state_file()
        for attempt in range(_REPLACE_RETRIES):
            try:
                os.replace(tmp_path, target)
                return
            except PermissionError:
                if attempt == _REPLACE_RETRIES - 1:
                    raise
                time.sleep(_REPLACE_BACKOFF_SECONDS * (2**attempt))
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise
