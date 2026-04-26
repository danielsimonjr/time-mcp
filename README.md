# time-mcp

A FastMCP server providing time, timezone, timer, stopwatch, and alarm tools for Claude Code.

## Tools

| Category | Tool | Purpose |
|----------|------|---------|
| **Time & Timezone (2)** | `get_current_time` | Current time in any IANA timezone (defaults to system zone) |
| | `convert_time` | Convert a `HH:MM` time between two IANA timezones |

*Timer, Stopwatch, and Alarm tools land in subsequent commits.*

## Prerequisites

- Python 3.10+
- A virtualenv (recommended at `~/.venvs/time-mcp/`)

## Installation

```bash
python -m venv ~/.venvs/time-mcp
source ~/.venvs/time-mcp/bin/activate    # or .Scripts\activate on Windows
pip install -e /path/to/time-mcp
```

## Register with Claude Code

Add to your MCP config (e.g. `~/.claude/local-marketplace/mcp-host/.mcp.json`):

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

Then run `/reload-plugins` in Claude Code. Tools appear as `mcp__plugin_mcp-host_time-mcp__*`.

## Development

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT — see [LICENSE](LICENSE).
