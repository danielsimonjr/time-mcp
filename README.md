# time-mcp

A TypeScript MCP server providing time, timezone, timer, stopwatch, and alarm
tools for Claude Code. Built on
[`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk)
v2 (MCP 2026-07-28 / MCP 2.0), [Luxon](https://moment.github.io/luxon/) for timezone/DST, and
[`chrono-node`](https://github.com/wanasit/chrono) for natural-language alarm
parsing.

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
| `stopwatch_stop` | Stop a running stopwatch and return final elapsed. **Idempotent** — double-stop returns OK with the original `stopped_at`. |
| `stopwatch_check` | Read elapsed without stopping. |
| `stopwatch_list` | All stopwatches (running and stopped). |

### Alarm — fire at absolute time (4)
| Tool | Purpose |
|------|---------|
| `alarm_set` | Set an alarm. Accepts natural language (`"in 4h"`, `"tomorrow at 9am"`, `"next Tuesday at 3pm"`) or absolute ISO (`"2030-12-31 23:59:00"`). Past times are rejected. Naive absolute strings and `today/tomorrow` patterns default to UTC; pass optional `timezone` (IANA name, e.g. `"America/New_York"`) to anchor them in a different zone. |
| `alarm_list` | All alarms with computed status (`pending`/`fired`/`cancelled`) + seconds-until-fire. |
| `alarm_check` | Look up a single alarm. |
| `alarm_cancel` | Idempotent cancellation. |

## Design notes

- **MCP 2026-07-28 (MCP 2.0).** The server uses `serveStdio` from the v2 SDK and
  implements `server/discover` for stateless capability negotiation. Legacy clients
  that still send the `initialize` handshake continue to work on the same stdio
  connection.
- **No daemons.** Status is *computed* at read time from stored timestamps.
  To react when a timer expires or an alarm fires, pair with Claude Code's
  `/loop` to poll, e.g.:
  ```
  /loop 30s timer_check abc12345; if status is "expired", do X
  ```
- **Optional notification hook.** A separate CLI entry, shipped two ways:
  `bundle/notify-hook.mjs` (committed, self-contained — **use this one**) and
  `dist/notify-hook.js` (emitted by `npm run build`, requires `node_modules`).
  When wired as a `UserPromptSubmit` hook in `~/.claude/settings.json`, it
  injects emoji-prefixed notifications for timers/alarms that have fired since
  the last check (one-shot via `notified_at`). See **Notification hook** below.
- **Persistent state** at `~/.time-mcp/state.json` (override via
  `TIME_MCP_STATE_DIR` env var). Atomic writes via temp-file rename, with
  retry-on-Windows-sharing-violation. UTF-8 throughout — emoji and accented
  labels round-trip cleanly. Concurrent mutations serialized via an in-process
  mutex. Corrupted state files are backed up to
  `state.json.corrupted.<timestamp>` instead of silently discarded.
- **Strict 1:1 JSON parity** with the prior Python implementation for valid
  sequential calls. One observable behavior change in 0.2.0: `stopwatch_stop`
  is now idempotent (matches `timer_cancel` and `alarm_cancel`).
- **All datetimes stored as UTC ISO 8601.** Timezone-aware everywhere inside
  the server; conversion happens only at the rendering boundary.
- **DST-correct**: `convert_time` rejects nonexistent wall-clock times (DST
  spring-forward gap) via a UTC round-trip check.

## Companion skill

This plugin ships a companion skill, `time` (`time-mcp:time`, slash trigger
`/time`), at `skills/time/SKILL.md`. It's a judgment layer over the 14 tools
above — no new tools of its own — that steers you toward the right family
(timer vs. stopwatch vs. alarm) and keeps the `_id`-based check/cancel/list
flow correct. All operations it covers are safe (read-only or ephemeral
timers), so it carries no confirmation gates.

## Prerequisites

- Node.js 24 or newer

## Installation

```bash
git clone https://github.com/danielsimonjr/time-mcp.git
cd time-mcp
npm install
npm run build
```

The build emits `dist/index.js` (MCP server) and `dist/notify-hook.js` (hook CLI).

`dist/` is **gitignored** — it does not survive a fresh clone, and it needs
`node_modules` present at runtime. For anything that must keep working across
clones and machine migrations (the plugin's MCP server, and the notification
hook), use the committed self-contained bundles instead:

```bash
npm run bundle          # both, via esbuild
npm run bundle:server   # -> bundle/index.mjs
npm run bundle:hook     # -> bundle/notify-hook.mjs
```

These are checked into the repo and require neither a build step nor
`node_modules`. Regenerate and commit them whenever `src/` changes.

## Register with Claude Code

Add to your MCP config (e.g., `~/.claude/local-marketplace/mcp-host/.mcp.json`):

```json
{
  "mcpServers": {
    "time-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/time-mcp/dist/index.js"]
    }
  }
}
```

Then run `/reload-plugins` in Claude Code. Tools appear under the
`mcp__time-mcp__*` prefix.

## Notification hook (optional)

Wire `bundle/notify-hook.mjs` into Claude Code so timer expirations and alarm
fires appear as in-session context on your next prompt — no `/loop` polling
required for the basic "tell me when it fires" use case.

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node C:/path/to/time-mcp/bundle/notify-hook.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

> **Point the hook at `bundle/notify-hook.mjs`, not `dist/notify-hook.js`.**
> `dist/` is gitignored and needs `node_modules`, so a hook wired to it fails
> with `MODULE_NOT_FOUND` (`node:internal/modules/cjs/loader`) on any fresh
> clone or machine migration — the build output simply isn't there. The bundle
> is committed and self-contained, so it works immediately after `git clone`.

On every prompt you submit (including `/loop` iterations), the hook reads
`~/.time-mcp/state.json`, finds timers with status `expired` and alarms with
status `fired` that haven't yet been notified, emits one notification per
item to Claude as `additionalContext`, and marks them notified so they don't
repeat. Output looks like:

```
🔔 Timer 'deploy check' (wxZ0Sg3B) expired 4m ago
🔔 Alarm 'meeting prep' (a8Kp2Lw9) fired 12s ago
```

The hook fails silently — any unexpected error returns exit code 0 with no
output, so a malformed state file or missing build never blocks your prompt.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests --max-warnings 0
npm test            # vitest run — 92 tests across 9 files
npm run build       # emit dist/
```

The test suite uses `process.env.TIME_MCP_STATE_DIR` (set to a per-test tmp
dir) to isolate state, so it never touches your real `~/.time-mcp/state.json`.
A mutex regression test races 50 concurrent `withState` callers and asserts no
lost updates; a corrupted-state test verifies the `.corrupted.<timestamp>`
backup behavior; a DST spring-forward test pins fake timers to 2026-03-08 and
verifies the round-trip gap detection.

## License

MIT — see [LICENSE](LICENSE).
