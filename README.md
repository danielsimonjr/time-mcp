# time-mcp

A FastMCP server providing time, timezone, timer, stopwatch, and alarm tools for Claude Code.

## Tools (14)

### Time & Timezone (2)
| Tool | Purpose |
|------|---------|
| `get_current_time` | Current time in any IANA timezone (defaults to system zone). Returns ISO datetime, HH:MM:SS, and DST flag. |
| `convert_time` | Convert a `HH:MM` wall-clock time between two IANA timezones. DST spring-forward gaps are detected and rejected. |

### Timer — countdown (4)
| Tool | Purpose |
|------|---------|
| `timer_start` | Start a countdown. Duration accepts `5m`, `1h30m`, `90s`, `1d2h3m4s`, or a bare-int seconds count. Returns 8-char ID. |
| `timer_list` | All timers with computed status (`running`/`expired`/`cancelled`) + remaining seconds. |
| `timer_check` | Look up a single timer. |
| `timer_cancel` | Idempotent cancellation. |

### Stopwatch — count up (4)
| Tool | Purpose |
|------|---------|
| `stopwatch_start` | Start counting up from now. Returns 8-char ID. |
| `stopwatch_stop` | Stop a running stopwatch and return final elapsed. **Not idempotent** — double-stop is an error. |
| `stopwatch_check` | Read elapsed without stopping. |
| `stopwatch_list` | All stopwatches (running and stopped). |

### Alarm — fire at absolute time (4)
| Tool | Purpose |
|------|---------|
| `alarm_set` | Set an alarm. Accepts natural language (`"in 4 hours"`, `"tomorrow at 9am"`) or absolute ISO (`"2030-12-31 23:59:00"`). Past times are rejected. Naive absolute strings interpreted as UTC. |
| `alarm_list` | All alarms with computed status (`pending`/`fired`/`cancelled`) + seconds-until-fire. |
| `alarm_check` | Look up a single alarm. |
| `alarm_cancel` | Idempotent cancellation. |

## Design notes

- **No daemons, no notifications.** Status is *computed* at read time from
  stored timestamps. To react when a timer expires or an alarm fires, pair
  with Claude Code's `/loop` to poll, e.g.:
  ```
  /loop 30s timer_check abc12345; if status is "expired", do X
  ```
- **Persistent state** at `~/.time-mcp/state.json` (override via
  `TIME_MCP_STATE_DIR` env var). Atomic writes via temp-file rename. UTF-8
  throughout, so emoji and accented labels round-trip cleanly.
- **All datetimes stored as UTC ISO 8601.** Timezone-aware everywhere
  inside the server; conversion happens only at the rendering boundary.
- **DST-correct**: `convert_time` rejects nonexistent wall-clock times
  (DST spring-forward gap) rather than silently producing the
  pre-transition offset.

## Prerequisites

- Python 3.10+
- A virtualenv (recommended: `~/.venvs/time-mcp/`)

## Installation

```bash
git clone https://github.com/danielsimonjr/time-mcp.git
cd time-mcp
python -m venv ~/.venvs/time-mcp
source ~/.venvs/time-mcp/bin/activate    # or .Scripts\activate on Windows
pip install -e .
```

## Register with Claude Code

Add to your MCP config (e.g., `~/.claude/local-marketplace/mcp-host/.mcp.json`):

```json
{
  "mcpServers": {
    "time-mcp": {
      "command": "C:/Users/<you>/.venvs/time-mcp/Scripts/python.exe",
      "args": ["-X", "utf8", "-m", "time_mcp_server"]
    }
  }
}
```

Then run `/reload-plugins` in Claude Code. Tools appear as
`mcp__plugin_mcp-host_time-mcp__*`.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The test suite uses `monkeypatch.setenv("TIME_MCP_STATE_DIR", tmp_path)` to
isolate state to a temporary directory per test, so it never touches your
real `~/.time-mcp/state.json`.

## License

MIT — see [LICENSE](LICENSE).
