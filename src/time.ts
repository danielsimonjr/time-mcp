import { DateTime, IANAZone } from "luxon";

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function tzExists(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

function systemZone(): string {
  const z = DateTime.local().zoneName;
  return z && tzExists(z) ? z : "UTC";
}

function snapshot(dt: DateTime): { timezone: string; datetime: string; time: string; is_dst: boolean } {
  return {
    timezone: dt.zoneName ?? "UTC",
    datetime: dt.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? "",
    time: dt.toFormat("HH:mm:ss"),
    is_dst: dt.isInDST,
  };
}

export function getCurrentTime(tzName: string | null | undefined): string {
  let zone: string;
  if (tzName) {
    if (!tzExists(tzName)) {
      return JSON.stringify({ status: "error", error: `Unknown IANA timezone: '${tzName}'` });
    }
    zone = tzName;
  } else {
    zone = systemZone();
  }
  const dt = DateTime.now().setZone(zone);
  return JSON.stringify({ status: "ok", ...snapshot(dt) });
}

export function convertTime(sourceTz: string, time: string, targetTz: string): string {
  if (!tzExists(sourceTz)) {
    return JSON.stringify({ status: "error", error: `Unknown source timezone: '${sourceTz}'` });
  }
  if (!tzExists(targetTz)) {
    return JSON.stringify({ status: "error", error: `Unknown target timezone: '${targetTz}'` });
  }
  const m = HHMM_RE.exec(time);
  if (!m) {
    return JSON.stringify({ status: "error", error: `Malformed time '${time}'; expected 24-hour HH:MM (e.g., '14:30')` });
  }
  const hour = +m[1];
  const minute = +m[2];
  if (hour > 23 || minute > 59) {
    return JSON.stringify({ status: "error", error: `Malformed time '${time}'; expected 24-hour HH:MM (e.g., '14:30')` });
  }
  const today = DateTime.now().setZone(sourceTz);
  const sourceDt = DateTime.fromObject(
    { year: today.year, month: today.month, day: today.day, hour, minute, second: 0 },
    { zone: sourceTz },
  );
  if (!sourceDt.isValid) {
    return JSON.stringify({
      status: "error",
      error: `Time '${time}' does not exist in ${sourceTz} on ${today.toFormat("yyyy-LL-dd")} (DST spring-forward gap)`,
    });
  }
  // Round-trip detection (Luxon doesn't always flag DST gaps as invalid)
  const roundTrip = sourceDt.toUTC().setZone(sourceTz);
  if (roundTrip.hour !== hour || roundTrip.minute !== minute) {
    return JSON.stringify({
      status: "error",
      error: `Time '${time}' does not exist in ${sourceTz} on ${today.toFormat("yyyy-LL-dd")} (DST spring-forward gap)`,
    });
  }
  const targetDt = sourceDt.setZone(targetTz);
  const offsetHours = (targetDt.offset - sourceDt.offset) / 60;
  return JSON.stringify({
    status: "ok",
    source: snapshot(sourceDt),
    target: snapshot(targetDt),
    offset_hours: offsetHours,
  });
}
