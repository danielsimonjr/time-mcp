# time-mcp → TypeScript SDK conversion — Design

**Date:** 2026-05-22
**Repo:** `C:/Users/danie/Dropbox/Github/time-mcp`
**Target version:** `0.2.0` (after cutover)
**Source:** Python `time_mcp_server` package, FastMCP-based, 867 LOC across 6 files

## 1. Scope

Convert the `time-mcp` MCP server from Python (FastMCP, `python -m time_mcp_server`) to TypeScript on `@modelcontextprotocol/sdk`, compiled to `dist/`. In-place replacement in the existing repo. Same approach as the completed `dropbox-mcp` conversion: real TypeScript, strict JSON-output parity (with explicit deviations noted in §9), keep the Python source until live-verified, then retire it.

Concretely: **14 MCP tools** + **1 separately-deployed CLI hook** (`notify-hook`).

The 14 tools: `get_current_time`, `convert_time`, `timer_start`/`timer_check`/`timer_list`/`timer_cancel`, `stopwatch_start`/`stopwatch_check`/`stopwatch_stop`/`stopwatch_list`, `alarm_set`/`alarm_check`/`alarm_list`/`alarm_cancel`.

## 2. Non-goals

- No new feature additions (no stopwatch reset/lap, no alarm snooze, no aging policy).
- No state-file path change — would break "existing state survives cutover."
- No state-field renames (`stopped_at` vs `cancelled_at` asymmetry preserved) — same reason.
- No state schema version field — current schema is stable; easy to add when needed.

## 3. Module layout

```
src/
  state.ts        — load/save state, makeId(); atomic write w/ Windows retry; mutex
  parsers.ts      — parseDuration() strict regex; parseAlarmTime() strict + chrono fallback
  time.ts         — getCurrentTime / convertTime; DST gap detection (Luxon)
  tools.ts        — TOOLS[] (14 defs) + HANDLERS map; each handler returns a JSON string
  index.ts        — Server wiring, ListTools/CallTool, StdioServerTransport
  notify-hook.ts  — Separate CLI entry → dist/notify-hook.js
tests/
  state.test.ts · parsers.test.ts · time.test.ts
  handlers-timer.test.ts · handlers-stopwatch.test.ts · handlers-alarm.test.ts
  notify-hook.test.ts · smoke.test.ts
```

Same shape as the completed dropbox-mcp. Larger `tools.ts` (14 tools vs 8) but split into the 4 logical groups (time, timer, stopwatch, alarm) inside.

## 4. State model — match Python exactly

| Aspect | Decision |
|---|---|
| Path | `path.join(os.homedir(), ".time-mcp", "state.json")` — matches Python |
| Env override | `TIME_MCP_STATE_DIR` (parent dir) |
| Format | UTF-8 JSON, 2-space indent, no ASCII escaping (matches Python `ensure_ascii=False`) |
| Atomic write | tempfile-in-same-dir → `fs.renameSync` with 3-retry exponential backoff on Windows `EBUSY`/`EPERM` |
| Schema | Literal-identical to Python — `{timers: {}, stopwatches: {}, alarms: {}}` |
| Forward compat | Missing top-level keys default to `{}`; unknown keys dropped on save |
| Existing state | **Live `~/.time-mcp/state.json` survives the cutover unchanged** — the TS server reads the same file |

## 5. Natural-language alarm parsing — strict → chrono fallback

**Strict grammar first** (deterministic, no library risk):

| Form | Example | Behavior |
|---|---|---|
| ISO 8601 absolute | `2030-12-31T23:59:00Z`, `2030-12-31 23:59:00` | Naive → interpreted in `TIMEZONE` arg, default UTC |
| Relative duration | `in 4h`, `in 1d2h`, `in 30m` | Re-uses `parseDuration` grammar |
| Today/tomorrow + HH:MM | `today at 14:30`, `tomorrow at 9:00` | In target timezone |

**`chrono-node` fallback** for anything strict doesn't match. Called with `forwardDate: true` (matches Python `dateparser`'s `PREFER_DATES_FROM: future` bias). Handles long-tail NL: "next Tuesday at 3pm", "in three hours", "Friday morning."

**Documented parity gap:** Unusual phrasings may parse slightly differently from Python `dateparser`. The strict path is byte-identical to a Python equivalent; the chrono path is best-effort. Common-case inputs (ISO timestamps + simple relative forms) hit the strict path and have no parity risk.

## 6. Timezone handling — Luxon

Library: **Luxon** (`luxon` npm) — mature, IANA-native, ICU-independent.

- **`get_current_time`**: `DateTime.now().setZone(tz)`. Format via `.toISO({suppressMilliseconds: true})`. `is_dst = dt.isInDST` (boolean, matches Python `bool(when.dst())`).
- **`convert_time`**: parse `HH:MM` in source zone (today's date) → `.setZone(target)`. `offset_hours = (target.offset - source.offset) / 60` (Luxon offsets in minutes).
- **DST spring-forward gap**: round-trip via UTC; if wall-clock changes, return Python's exact error wording: `"Time '02:30' does not exist in America/New_York on 2026-03-08 (DST spring-forward gap)"`.
- **System zone fallback**: `DateTime.local().zoneName` (matches Python `tzlocal.get_localzone_name()` semantically); UTC if undetectable.

## 7. notify_hook port

`src/notify-hook.ts` → `dist/notify-hook.js`. Stand-alone CLI; no MCP framing.

- Reads stdin (discards Claude Code payload — same as Python).
- Loads state via shared `state.ts`.
- Iterates `timers` then `alarms` in **insertion order** (JS object property order is insertion-preserving for string keys, matches Python 3.7+ dict order).
- Filter per record: `!record.cancelled_at && !record.notified_at && now >= record.expires_at` (or `fires_at`).
- For each qualifying record: format line, mutate `record.notified_at = now.toISOString()`.
- If any lines: save state, emit `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": lines.join("\n")}}` to stdout.
- If save fails: emit lines anyway (matches Python — better to duplicate next turn than silently drop).
- Bell: literal `\u{1F514}` (🔔).
- `formatSeconds(s)`: `<60→"${s}s"`, `<3600→"${m}m"`, `<86400→"${h}h"`, else `${d}d` (integer division, no plural).

## 8. ID generation, error handling

- **IDs**: `crypto.randomBytes(6).toString('base64url')` → 8-char base64url, ~48 bits entropy. Matches Python `secrets.token_urlsafe(6)`.
- **Errors**: Every Python error string reproduced **verbatim** — they are the contract. The full list is enumerated in tests. Examples: `"Unknown IANA timezone: 'Bogus/Zone'"`, `"Malformed duration 'xyz'; expected forms like '5m', '1h30m', '90s', '2d'"`, `"Alarm time '...' is in the past (...)"`, `"Could not parse alarm time: '...'"`.
- **Response shape**: `{"status": "ok", ...}` or `{"status": "error", "error": "..."}`. Tools return JSON strings.

## 9. Design flaws fixed

Five surgical improvements over the Python implementation. Net effect on output: **byte-identical JSON for valid sequential calls; one observable behavior change (§9.2); three invisible bug fixes; better tool metadata.**

### 9.1 Concurrent state mutation race ✓ fix

**Problem:** Each tool does `load_state → mutate → save_state` without locking. Python's `asyncio.to_thread` runs handlers concurrently. Two simultaneous calls can race: both load snapshot S, both mutate, both save — the second `save` silently overwrites the first.

**Fix:** A single Promise-chain mutex around all state mutations in `state.ts`:

```typescript
let queue: Promise<unknown> = Promise.resolve();
export async function withState<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const s = await loadState();
    const result = await fn(s);
    await saveState(s);
    return result;
  });
  queue = next.catch(() => {}); // don't poison the queue on errors
  return next;
}
```

All 12 state-mutating handlers go through `withState`. Reads (`*_check`, `*_list`) bypass the mutex — each reads fresh from disk, no consistency risk.

### 9.2 stopwatch_stop idempotency ✓ fix — **observable behavior change**

**Problem:** `timer_cancel` and `alarm_cancel` are idempotent (cancelling-while-cancelled returns OK). `stopwatch_stop` errors with `"Stopwatch 'xyz' is already stopped"`. Inconsistent; an LLM retrying because it's unsure the call took will get a confusing error.

**Fix:** `stopwatch_stop` returns the current view when already stopped (no error). Same `cancelled_at`-style idempotency.

**This is the one observable behavior delta in the entire port** — explicitly called out in the README and CHANGELOG.

### 9.3 State corruption recovery ✓ fix

**Problem:** `state.py` catches `json.JSONDecodeError` and silently returns `DEFAULT_STATE`. If state.json gets corrupted (power loss mid-write, disk issue), **every timer, alarm, and stopwatch vanishes with no warning**.

**Fix:** On parse failure in `loadState()`:
1. Rename the bad file to `state.json.corrupted.<ISO-timestamp>` (data preserved + recoverable).
2. Log one line to stderr: `"time-mcp: state.json failed to parse, moved to <path>; starting from empty state"`.
3. Return defaults (server continues running).

### 9.4 MCP tool annotations ✓ fix (port-time improvement)

Python FastMCP didn't surface these. TS SDK does. Per-tool:

| Annotation | Tools |
|---|---|
| `readOnlyHint: true` | `get_current_time`, `convert_time`, `timer_check`, `timer_list`, `stopwatch_check`, `stopwatch_list`, `alarm_check`, `alarm_list` (8 tools) |
| `destructiveHint: false` (default) | All state-mutating tools — none of them delete data (cancellations are soft via `cancelled_at`) |

No tool gets `destructiveHint: true`; nothing in this server permanently destroys data.

### 9.5 Stderr logging on failures ✓ fix

**Problem:** Both server and `notify_hook` are silent on all failures. Debugging is guesswork.

**Fix:** One stderr line per failure mode. Examples:
- State load corruption: `"time-mcp: state.json failed to parse, moved to ...; starting from empty state"`
- State save failure: `"time-mcp: save_state failed after 3 retries: <error>"`

Stdout stays clean (JSON-RPC). Stderr doesn't disrupt MCP transport.

## 10. Testing

vitest, mirroring dropbox-mcp's approach. **Target ≥58 tests** across 8 files:

- `state.test.ts` — load/save round-trip; `TIME_MCP_STATE_DIR` override; missing-keys forward-compat; **corrupted-file backup + stderr log (9.3)**; **withState() serializes concurrent mutations (9.1)**.
- `parsers.test.ts` — `parseDuration` (strict regex; "0s" allowed; empty/malformed errors); `parseAlarmTime` strict path (ISO, `in Nh Nm`, `today/tomorrow at HH:MM`); chrono fallback smoke test (`"next Tuesday at 3pm"` parses to *some* valid future timestamp; we don't assert exact value).
- `time.test.ts` — `get_current_time` with valid/invalid IANA names; `convert_time` happy path; DST spring-forward gap error; fall-back ambiguity (uses earlier wall time).
- `handlers-timer.test.ts` — `start`/`check`/`list`/`cancel`; expiry computation; idempotent cancel.
- `handlers-stopwatch.test.ts` — `start`/`check`/`stop`/`list`; **idempotent stop (9.2)** — explicit test that double-`stop` returns OK with unchanged `stopped_at`.
- `handlers-alarm.test.ts` — `set`/`check`/`list`/`cancel`; past-time rejection; unparseable-input error.
- `notify-hook.test.ts` — fires for expired+unnotified, skips notified, skips cancelled; sets `notified_at`; format of bell line; `formatSeconds` edge cases.
- `smoke.test.ts` — `TOOLS.map(t=>t.name).sort() === Object.keys(HANDLERS).sort()`; **annotation symmetry: all 14 tools have an annotations block; readOnlyHint exactly matches the §9.4 table.**

## 11. Cutover (Task 9 equivalent)

**`.mcp.json`:**
```json
"time-mcp": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/Users/danie/Dropbox/Github/time-mcp/dist/index.js"],
  "env": { "_RETRY": "2026-05-22T<ts>-ts-cutover" }
}
```

**`~/.claude/settings.json`** UserPromptSubmit hook:
```json
{
  "type": "command",
  "command": "node C:/Users/danie/Dropbox/Github/time-mcp/dist/notify-hook.js",
  "timeout": 5
}
```

`/reload-plugins` after both edits. Verify: live `get_current_time` + `timer_start`/`timer_check` round-trip + UserPromptSubmit triggers `notify-hook` correctly.

## 12. Cleanup (Task 10 equivalent — post-verification only)

- Remove `src/time_mcp_server/` (Python source), `pyproject.toml`, `requirements.txt`.
- Update `README.md` (TypeScript invocation, dependencies).
- Add `CHANGELOG.md` entry: `## [0.2.0] - 2026-05-22` covering the port + the 5 design fixes + the one observable behavior change (9.2).
- Retire `C:/Users/danie/.venvs/time-mcp`.

## 13. Risks / open items

| Risk | Mitigation |
|---|---|
| chrono-node parses an unusual phrase differently from Python `dateparser` | Documented parity gap; strict grammar catches the common cases; tests cover the strict path exhaustively |
| Luxon DST handling differs from `zoneinfo` on some IANA names | Targeted test suite around DST transitions (spring forward, fall back, ambiguous local times) |
| Node 24 cold-start time exceeds Claude Code's 30s MCP timeout on first call | Same as dropbox-mcp — measured at ~7s; well within budget |
| `notify-hook` node startup adds latency vs Python's already-loaded interpreter | Node 24 cold-start is ~100-200ms for a script-only CLI (no heavy imports). Well under the 5s hook timeout |
| Existing `~/.time-mcp/state.json` has a field shape the TS port doesn't expect | Tested: forward-compat preserves unknown keys; missing keys default to `{}` |
