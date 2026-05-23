#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { loadState, saveState } from "./state.js";
import type { State } from "./state.js";

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function labelPart(label: string | null | undefined): string {
  return label ? ` '${label}'` : "";
}

export function collectNotifications(state: State, now: DateTime): { lines: string[]; state: State } {
  const lines: string[] = [];
  const nowIso = now.toISO() ?? "";

  for (const [timerId, record] of Object.entries(state.timers)) {
    if (record.cancelled_at || record.notified_at) continue;
    const expiresAt = DateTime.fromISO(record.expires_at);
    if (now < expiresAt) continue;
    const ago = formatSeconds(Math.floor(now.diff(expiresAt, "seconds").seconds));
    lines.push(`\u{1F514} Timer${labelPart(record.label)} (${timerId}) expired ${ago} ago`);
    record.notified_at = nowIso;
  }

  for (const [alarmId, record] of Object.entries(state.alarms)) {
    if (record.cancelled_at || record.notified_at) continue;
    const firesAt = DateTime.fromISO(record.fires_at);
    if (now < firesAt) continue;
    const ago = formatSeconds(Math.floor(now.diff(firesAt, "seconds").seconds));
    lines.push(`\u{1F514} Alarm${labelPart(record.label)} (${alarmId}) fired ${ago} ago`);
    record.notified_at = nowIso;
  }

  return { lines, state };
}

async function readStdin(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", () => resolve());
    // If nothing is piped in, resolve quickly.
    setTimeout(() => resolve(), 50);
  });
}

async function main(): Promise<number> {
  try { await readStdin(); } catch { /* ignore */ }

  let state: State;
  try {
    state = await loadState();
  } catch {
    return 0;
  }

  const { lines, state: mutated } = collectNotifications(state, DateTime.utc());
  if (lines.length === 0) return 0;

  try {
    await saveState(mutated);
  } catch {
    // If save fails, still emit notifications — better to duplicate next turn than silently drop.
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  return 0;
}

// Only run as CLI entry point, not when imported by tests or other modules.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}
