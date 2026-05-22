import * as chrono from "chrono-node";
import { DateTime } from "luxon";

const DURATION_RE = /^\s*(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$/;
const BARE_NUMBER_RE = /^\s*\d+\s*$/;
const RELATIVE_IN_RE = /^\s*in\s+(.+?)\s*$/i;
const TODAY_AT_RE = /^\s*today\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i;
const TOMORROW_AT_RE = /^\s*tomorrow\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i;
// Accepts "YYYY-MM-DD HH:MM[:SS][Z|+HH:MM]" or "YYYY-MM-DDTHH:MM[:SS][Z|+HH:MM]"
const ISO_RE =
  /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?\s*$/;

export function parseDuration(s: string): number {
  if (!s || !s.trim()) throw new Error("Duration is empty");
  if (BARE_NUMBER_RE.test(s)) return parseInt(s.trim(), 10);
  const m = DURATION_RE.exec(s);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) {
    throw new Error(
      `Malformed duration '${s}'; expected forms like '5m', '1h30m', '90s', '2d'`
    );
  }
  const [, d, h, mi, sec] = m;
  return (
    (+(d ?? 0)) * 86400 +
    (+(h ?? 0)) * 3600 +
    (+(mi ?? 0)) * 60 +
    (+(sec ?? 0))
  );
}

function strictParse(s: string, tzName: string): DateTime | null {
  // Try ISO
  const iso = ISO_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, offset] = iso;
    const args = {
      year: +y,
      month: +mo,
      day: +d,
      hour: +h,
      minute: +mi,
      second: sec ? +sec : 0,
    };
    if (offset) {
      // Has explicit zone/offset — let Luxon parse it as ISO directly
      const dt = DateTime.fromISO(s.trim().replace(" ", "T"), {
        setZone: true,
      });
      return dt.isValid ? dt : null;
    }
    // Naive — interpret in tzName (default UTC)
    return DateTime.fromObject(args, { zone: tzName });
  }
  // Try "in <duration>"
  const rel = RELATIVE_IN_RE.exec(s);
  if (rel) {
    try {
      const secs = parseDuration(rel[1]);
      return DateTime.now().setZone(tzName).plus({ seconds: secs });
    } catch {
      return null;
    }
  }
  // Try "today at HH:MM[:SS]"
  const today = TODAY_AT_RE.exec(s);
  if (today) {
    const [, h, mi, sec] = today;
    const now = DateTime.now().setZone(tzName);
    return now.set({
      hour: +h,
      minute: +mi,
      second: sec ? +sec : 0,
      millisecond: 0,
    });
  }
  // Try "tomorrow at HH:MM[:SS]"
  const tom = TOMORROW_AT_RE.exec(s);
  if (tom) {
    const [, h, mi, sec] = tom;
    const now = DateTime.now().setZone(tzName);
    return now
      .plus({ days: 1 })
      .set({ hour: +h, minute: +mi, second: sec ? +sec : 0, millisecond: 0 });
  }
  return null;
}

export function parseAlarmTime(s: string, tzName?: string): DateTime {
  const zone = tzName || "UTC";
  const strict = strictParse(s, zone);
  if (strict && strict.isValid) return strict;
  // Fallback: chrono-node with forwardDate
  const results = chrono.parse(s, new Date(), { forwardDate: true });
  if (results.length > 0) {
    const date = results[0].start.date();
    // chrono returns a JS Date representing local wall-clock time.
    // DateTime.fromJSDate(date) interprets it as local Luxon time (system zone).
    // We want to keep the wall-clock reading (e.g. "3pm" stays hour 15) but
    // interpret it in the target zone — so we use keepLocalTime:true when re-zoning.
    const dt = DateTime.fromJSDate(date).setZone(zone, { keepLocalTime: true });
    if (dt.isValid) return dt;
  }
  throw new Error(`Could not parse alarm time: '${s}'`);
}
