# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-31

### Changed

- **MCP 2026-07-28 (MCP 2.0) support.** Upgraded from `@modelcontextprotocol/sdk` v1 to
  `@modelcontextprotocol/server` v2 and switched the stdio entry from a hand-wired
  `Server.connect(StdioServerTransport)` to `serveStdio(buildServer)`. The server now
  implements the stateless `server/discover` handshake and serves both modern
  (2026-07-28) and legacy (2025-era `initialize`) clients on the same stdio connection.
- **Tool registration via `McpServer.registerTool`.** The low-level `tools/list` and
  `tools/call` handlers are replaced by a `buildServer()` factory that registers all 14
  tools on a fresh `McpServer` instance per connection era.

### Added

- **Protocol conformance tests** (`tests/protocol.test.ts`) exercising `server/discover`,
  `tools/list`, and `tools/call` over the 2026-07-28 revision via `createMcpHandler`.

## [0.3.2] - 2026-08-15

### Security

- 🔴 **The shipped bundle did not contain the 2026-08-08 dependency patches.**
  `bundle/index.mjs` is the artifact the plugin actually loads, and esbuild inlines
  dependencies into it — but it was last built **2026-07-26**, thirteen days before
  `f9def20` patched `js-yaml` / `fast-uri` / `nanoid` / `dompurify`. A bundle built on
  07-26 cannot contain a change made on 08-08, so those fixes reached the lockfile and
  stopped there. Rebuilt: `index.mjs` 1,319,166 → 1,282,516 bytes and
  `notify-hook.mjs` 803,499 → 782,281. Verified by rebuilding and diffing against the
  committed artifact, then re-running a real MCP `initialize` handshake against the
  result — not by trusting the lockfile.

### Fixed

- **`package.json` was never bumped past 0.2.0, and the repo had no tags at all.**
  `.claude-plugin/plugin.json` had been moved to 0.3.0 and then 0.3.1 (the latter
  explicitly "to force redeploy of the fast-uri security fix"), but `package.json`
  stayed at `0.2.0` and nothing was ever tagged — so the version the plugin cache keys
  on had nothing behind it, and the forced redeploy shipped a bundle that predated the
  next security patch anyway. `package.json`, `plugin.json` and the marketplace entry
  now all read `0.3.2`; `v0.3.0` and `v0.3.1` are tagged retroactively so
  `git describe` has something to measure.
- **Package marked `private`.** The npm name `time-mcp` belongs to another maintainer,
  so this repo is GitHub-release-only; `private: true` makes that structural rather
  than remembered.
- **The server version was a second source of truth, and that is why the drift was
  invisible.** `src/index.ts` hard-coded `version: "0.2.0"` in the MCP `serverInfo`,
  so the running server reported `0.2.0` to every client no matter what
  `package.json`, `plugin.json` or the marketplace said. The literal is gone: the
  version is now injected at bundle time from `package.json` via esbuild `define`
  (`__PKG_VERSION__`), leaving one place a version is written. Verified by an
  `initialize` handshake against the rebuilt bundle, which now answers `0.3.2`.
- **`npm run bundle` failed with "esbuild is not recognized".** `esbuild` is a
  devDependency but was absent from this repo's `node_modules`, so both bundle scripts
  died immediately. The two ad-hoc `bundle:server` / `bundle:hook` shell invocations are
  replaced by `scripts/build.mjs`, which uses esbuild's JS API and fails loudly rather
  than silently leaving a stale artifact in place.

  **Correction (2026-08-15).** This entry originally attributed that failure to esbuild's
  postinstall being blocked machine-wide. **That was wrong.** `npm config get
  ignore-scripts` returns `false` on this machine, and Starship independently measured
  `@esbuild` present across 21 repos. esbuild loads here fine. The actual cause was a
  stale `node_modules` in this repo plus a guard of mine (`ls node_modules || npm ci`)
  that skipped the reinstall because the directory merely existed. The durable finding is
  unchanged and is the important one — **the committed bundle was thirteen days older
  than its own security patch and nothing detected it** — but the cause is "nobody
  rebuilt after the change", which wants a rebuild-check in CI, not a tooling unblock.

### Security (2026-08-04)

Lock-only via `npm update`; no manifest changed. Transitive dependencies of the
MCP SDK / server stack:

- `ip-address` -> 10.4.0 (1 high + 2 medium; needed 10.3.1)
- `hono` -> 4.13.0 (medium; needed 4.12.34)
- `fast-uri` -> 3.1.5 (high; needed 3.1.5)

Only the packages present in this repo's tree are listed above by the resolver;
`npm audit` reports 0 vulnerabilities. Verified with `npm ci` plus this repo's
own build and test scripts.


### Added

- **Windows CI leg.** CI ran on `ubuntu-latest` only — but Windows is the *production*
  platform for this MCP server (it runs on the user's Windows box), so CI had never once
  tested the OS the server actually ships on. The `build` job now runs a
  `[ubuntu-latest, windows-latest]` matrix.

### Security

- **Removed a HIGH-severity vulnerability from the shipped bundle: `fast-uri` 3.1.2 → 3.1.4**
  via an npm `overrides` entry. It reaches us transitively —
  `@modelcontextprotocol/sdk@1.29.0 → ajv@8.20.0 → fast-uri` — and `ajv` uses it for schema
  `$ref` resolution during tool-argument validation, so it is genuinely present in the artifact
  (6 references in `bundle/index.mjs`). Bumping the SDK was **not** an option: it is already at
  the latest published version (1.29.0), so the vulnerable range is pinned inside its current tree.
  Advisories: GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6 (host confusion via literal backslash /
  failed IDN canonicalization). Production audit: 4 vulns (1 high) → **3 vulns, 0 high**.
  - `bundle/index.mjs` regenerated so the fix actually ships (`be990fd8…` → `86a5c1f1…`).
    `bundle/notify-hook.mjs` is byte-identical, as expected — the hook does not use the SDK.
- **Deliberately NOT fixed: `@hono/node-server` <2.0.5 (moderate, serve-static path traversal).**
  The fix requires a **major** bump (1.19.14 → ≥2.0.5) forced inside the SDK's own tree, and the
  vulnerable code is **not reachable and not present**: this server imports only
  `StdioServerTransport` (`.mcp.json` type `stdio`), never an HTTP/SSE transport, and esbuild
  tree-shakes it out — **`serveStatic` appears 0 times in `bundle/index.mjs`**. Forcing a major
  on the SDK to silence an advisory for code absent from the binary would add more risk than it
  removes. Revisit when the SDK itself moves to hono 2.x.
  The remaining `postcss` / `brace-expansion` highs are dev-only (0 references in the bundle).

### Changed

- **Dependabot now ignores TypeScript `>=7.0.0`, ending a permanently-red CI branch.**
  PR #12 (`typescript` 5.9.3 → 7.0.2) had failed CI on every run since 2026-07-15. The
  cause was *not* TS 7 breaking our code — CI never reached `typecheck`. It died in
  `npm ci` with `ERESOLVE`, because `typescript-eslint@8.65.0` (and every published
  `8.65.1-alpha`) declares `peer typescript ">=4.8.4 <6.1.0"`. No stable
  `typescript-eslint` 9.x exists yet, so the bump is simply not installable.
  Verified locally: TS 7.0.2 conflicts, TS 6.0.3 resolves cleanly.
  - Deliberately **not** fixed with `--legacy-peer-deps`/`--force`, which would have
    installed a knowingly-broken lint toolchain to turn the check green.
  - Scoped to `>=7.0.0` rather than "all majors" so TS 6.x upgrades still flow.
  - The ignore entry documents its own removal trigger
    (`npm view typescript-eslint peerDependencies.typescript`).

### Fixed

- **Forward-compat with TypeScript 6: `compilerOptions.types` is now explicit (`["node"]`).**
  Under TS 6, `tsc --noEmit` failed with 22 errors — `TS2591: Cannot find name 'process'`
  and `TS2503: Cannot find namespace 'NodeJS'` — even though `@types/node` 26.1.1 was
  installed *and* visibly in the program (21 files, zero errors with `skipLibCheck` off).
  TypeScript 6 no longer auto-includes `@types/*` packages as a source of **global**
  declarations: the `node:*` imports still resolved as modules, but the ambient globals
  were never applied. Listing `node` explicitly restores them.
  - Measured, not guessed: `types: ["node"]` → **0 errors**; `module/moduleResolution:
    nodenext` → 22; `node18` → 22; unchanged baseline → 22.
  - Verified green under **both** TS 5.9.3 (currently pinned) and TS 6.0.3 —
    typecheck, lint (`--max-warnings 0`), 92/92 tests, and build.
  - Also good hygiene independent of TS 6: an explicit `types` list narrows the global
    scope and shortens compile time.

- **`UserPromptSubmit` hook died with `MODULE_NOT_FOUND` on a fresh clone — the hook was
  wired to a gitignored build artifact.** `~/.claude/settings.json` ran
  `node .../time-mcp/dist/notify-hook.js`, but `dist/` is in `.gitignore`, so it never
  arrived with the EVO-X2 migration (`node_modules` was absent too — the repo had never
  been built on that machine). Every prompt submission threw
  `Error: Cannot find module ... at node:internal/modules/cjs/loader:1517`. The MCP
  *server* was immune because `.mcp.json` launches the **committed** `bundle/index.mjs`;
  only the hook depended on an artifact that cannot survive `git clone`.
  - Added **`bundle/notify-hook.mjs`** — a committed, self-contained esbuild bundle
    (764 kB), the same durability pattern the server already used. Verified to run with
    `node_modules` renamed away.
  - Added reproducible **`npm run bundle` / `bundle:server` / `bundle:hook`** scripts and
    pinned **`esbuild` 0.28.1** as a devDependency. Both bundles had been produced by
    hand-typed `npx esbuild` invocations recorded nowhere in the repo; now anyone can
    regenerate them. (`bundle:server` verified to emit a bundle that completes an MCP
    `initialize` handshake; `bundle/index.mjs` itself is left unchanged here to keep this
    commit atomic.)
  - **README corrected** — it documented `dist/notify-hook.js` as *the* hook path in three
    places, which is the upstream cause of this class of failure. It now points at the
    bundle and states why, and the Installation section documents that `dist/` is
    gitignored and needs `node_modules`.
- **`nowIso()` UTC hazard** — the `?? new Date().toISOString()` fallback returned
  local time (corrupting UTC comparisons) and was unreachable. Replaced with an
  explicit null-check that throws. Same pattern fixed in `timer_start` and
  `alarm_set`.
- **Single clock read per cancel/stop handler** — `timer_cancel`, `alarm_cancel`,
  and `stopwatch_stop` previously made two independent `DateTime.utc()` calls: one
  to stamp `cancelled_at`/`stopped_at`, another to build the returned view. A race
  could produce a view inconsistent with the persisted timestamp. Now a single
  `DateTime.utc()` is captured and used for both.
- **Zod validation of persisted records** — malformed records (missing required
  fields like `expires_at`) were loaded with `as` casts, causing
  `DateTime.fromISO(undefined)` → NaN in `remaining_seconds`/`elapsed_seconds`.
  `loadState()` now validates each record via Zod `safeParse`, dropping and logging
  malformed entries instead of propagating NaN.

### Added
- **Companion skill** — `time` (`time-mcp:time`, `/time`), a judgment layer
  over the 14 tools that steers between timer/stopwatch/alarm families and
  keeps the `_id`-based check/cancel/list flow correct. Ships at
  `skills/time/SKILL.md`.
- **`eslint` flat-config lint gate** — `npm run lint` runs eslint 9 +
  `typescript-eslint` recommended over `src/` and `tests/`, `--max-warnings 0`.
  Rules: `no-non-null-assertion` and `no-explicit-any` as errors.
- **Optional `timezone` param for `alarm_set`** — pass an IANA zone name (e.g.
  `"America/New_York"`) to anchor naive times like `"today at 23:00"` in a
  specific timezone instead of UTC. Fully additive; omitting it preserves
  existing behavior.
- **Coverage tests** — timer_list/alarm_list/stopwatch_list status paths
  (`cancelled`, `expired`, `fired`, `stopped`); missing-required-arg error
  paths for check/cancel/stop handlers.

### Removed
- **Stale Python test files** (`tests/__init__.py`, `test_alarm.py`,
  `test_notify_hook.py`, `test_parsers.py`, `test_state.py`,
  `test_stopwatch.py`, `test_time.py`, `test_timer.py`, `__pycache__/`)
  — left over from the pre-0.2.0 Python implementation.

### Changed
- **Conversion docs tracked** — `docs/superpowers/plans/` and
  `docs/superpowers/specs/` added to version control.
- `.gitignore` note corrected: runtime state lives at `~/.time-mcp/state.json`
  (outside the repo); the old `.time-mcp-state.json` entry was wrong.

### Tests
- 92 vitest tests across 9 files (up from 75 across 9 at start of this pass).

---

## [0.2.0] - 2026-05-23

### Changed
- **Rewrote in TypeScript** on `@modelcontextprotocol/sdk`. The Python
  `time_mcp_server` package is retired; the server is now `node dist/index.js`,
  and the UserPromptSubmit hook is now `node dist/notify-hook.js`. Tool JSON
  output is byte-identical to the Python implementation for valid sequential
  calls. The state file at `~/.time-mcp/state.json` is read in place — existing
  timers/alarms/stopwatches survive the migration unchanged.
- **`stopwatch_stop` is now idempotent.** Stopping an already-stopped stopwatch
  returns `status: "ok"` with the original `stopped_at` (first-stop wins),
  instead of `"Stopwatch '<id>' is already stopped"`. This is the only
  observable behavior delta in the port. Aligns with `timer_cancel` and
  `alarm_cancel`, which were already idempotent.

### Fixed
- **Concurrent state-mutation race.** Each tool's load → mutate → save cycle is
  now serialized via a Promise-chain mutex (`withState`). The previous Python
  implementation ran handlers concurrently via `asyncio.to_thread` and could
  silently lose one update when two saves landed in close succession.
- **Silent corrupted-state recovery.** When `state.json` fails to parse, the
  bad file is now moved to `state.json.corrupted.<ISO-timestamp>` and a line
  is logged to stderr before falling back to empty defaults. The Python
  implementation silently discarded all timers/alarms/stopwatches.
- **Stderr logging on save failures** — previously silent.

### Added
- `readOnlyHint` / `destructiveHint` annotations on all 14 tools (8 read-only,
  6 mutating but non-destructive). FastMCP did not surface these; the
  TypeScript MCP SDK does.

### Removed
- Python source: `src/time_mcp_server/`, `pyproject.toml`. Replaced by
  `src/*.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`.

### Tests
- 76 vitest tests across 8 files: state persistence + mutex + corruption
  recovery (10), parsers (14), time/DST (9), 4 handler suites (24), notify-hook
  pure-function coverage (12), tool-definition annotations (6), `TOOLS↔HANDLERS`
  symmetry smoke test (1).

---

## [0.1.0] - 2026-04-26 (Python — retroactively versioned)

The complete Python implementation, never tagged as a release. All entries
below describe the Python codebase that landed before the TypeScript rewrite.
Note: in this Python version, `stopwatch_stop` was **not** idempotent (0.2.0
changes this — see above).

### Added
- `time_mcp_server.notify_hook` module — Claude Code `UserPromptSubmit`
  hook that injects emoji-prefixed notifications for expired timers and
  fired alarms into the session context. One-shot semantics via a
  `notified_at` field on each record (existing records without the field
  are treated as pending; schema-repair on first save). Designed to fail
  silently (always returns exit 0) so a malformed state file or other
  unexpected error never blocks the user's prompt.
- 11 unit tests for the hook including pure-function `collect_notifications`
  coverage (empty state, expired timer, fired alarm, cancelled-skip,
  already-notified-skip, running-skip, unlabeled-items, multiple-items,
  legacy records without `notified_at`) plus 2 subprocess smoke tests
  (no-state exit, expired-timer JSON output + persistence).
- README "Notification hook (optional)" section with `settings.json`
  config snippet.

### Changed
- `src/time_mcp_server/__init__.py` no longer eagerly imports
  `time_mcp_server.server` at package load time. This keeps
  `import time_mcp_server.notify_hook` cheap (avoids pulling in FastMCP /
  pydantic / dateparser per `UserPromptSubmit` hook fire). Tests and the
  `python -m time_mcp_server` entry point continue to import from
  submodules directly.

### Added
- Four alarm (absolute-time fire) tools: `alarm_set(when, label?)`,
  `alarm_list()`, `alarm_check(alarm_id)`, `alarm_cancel(alarm_id)`. State
  persisted under `state["alarms"]`. Status (`pending` / `fired` /
  `cancelled`) is computed at read time. Accepts natural-language times
  via `parse_alarm_time` (e.g. `"in 4 hours"`, `"tomorrow at 9am"`,
  `"2030-12-31 23:59:00"`); times in the past are rejected. `alarm_cancel`
  is idempotent.
- 12 unit tests for alarm lifecycle including absolute/relative input,
  fired status via injected past timestamps, mixed-status list, past-time
  rejection.
- Four stopwatch (count-up) tools: `stopwatch_start(label?)`,
  `stopwatch_stop(stopwatch_id)`, `stopwatch_check(stopwatch_id)`,
  `stopwatch_list()`. State persisted under `state["stopwatches"]`. Status
  (`running` / `stopped`) and elapsed time are computed at read time.
  `stopwatch_stop` is **not** idempotent — stopping an already-stopped
  stopwatch returns an error so double-stop bugs surface clearly.
- 10 unit tests for stopwatch lifecycle including injected-state checks
  for both running and stopped variants.
- Four timer (countdown) tools: `timer_start(duration, label?)`,
  `timer_list()`, `timer_check(timer_id)`, `timer_cancel(timer_id)`. State
  is persisted under `state["timers"]`. Status (`running` / `expired` /
  `cancelled`) is *computed* at read time from `expires_at` and
  `cancelled_at` — no daemon needed. `timer_cancel` is idempotent. All
  durations parsed via `/loop`-compatible syntax (`5m`, `1h30m`, `90s`, …).
- 12 unit tests for timer lifecycle including expired-via-injected-state,
  cancellation flow, missing-ID errors, and idempotent cancel.
- Persistence layer at `src/time_mcp_server/state.py`: JSON state file at
  `~/.time-mcp/state.json` (override via `TIME_MCP_STATE_DIR`), atomic writes
  via tempfile + `os.replace` with 3-attempt retry-on-Windows-sharing-violation,
  forward-compatible schema repair, UTF-8 throughout (labels with emoji or
  accented characters round-trip cleanly).
- `make_id()` helper returning 8-char base64url IDs (~48 bits entropy).
- Parsers module at `src/time_mcp_server/parsers.py`:
  - `parse_duration` accepts `5m`, `1h30m`, `90s`, `1d2h3m4s`, or a bare
    integer (seconds), matching `/loop`'s syntax. Rejects out-of-order
    components, decimals, negatives, and unknown units.
  - `parse_alarm_time` wraps `dateparser` with deterministic UTC-default
    interpretation of naive absolute timestamps; relative phrases like
    "in 4 hours" and "tomorrow at 9am" supported. Optional `tz_name` lets
    callers anchor naive strings in a specific zone.
- 31 new unit tests (8 state, 23 parsers) including UTF-8 round-trip, DST-
  aware conversion test, malformed-input matrix.

### Changed (Initial release retroactively)
- Initial project scaffold: `pyproject.toml`, `.gitignore`, `LICENSE` (MIT),
  `README.md`, `src/time_mcp_server/` package layout, `tests/`.
- Two FastMCP tools:
  - `get_current_time(timezone?)` — current time in any IANA timezone,
    defaulting to the system local zone via `tzlocal` (UTC fallback if
    detection fails).
  - `convert_time(source_timezone, time, target_timezone)` — converts a
    24-hour `HH:MM` wall-clock time between two IANA zones, anchored to the
    source zone's current date.
- DST spring-forward gap detection in `convert_time`: nonexistent wall-clock
  times (e.g., `02:30` on a US spring-forward day) return an error rather
  than silently producing the pre-transition offset.
- 15 unit tests covering valid/invalid timezones, DST gap, DST fall-back
  ambiguity (fold=0 acceptance), summer vs. winter `is_dst` flag, and naive-
  datetime rejection in `_zone_snapshot`.
