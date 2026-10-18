import type { ActualPower, ActualSegment } from './types';
import { addDays, formatDM, formatHM, kyivDateKey, kyivMinutesOfDay, kyivWallTimeToInstant } from './time';
import { formatDurationLong } from './widget-state';

export const ACTUAL_STALE_MS = 10 * 60_000;

/** A piece of one Kyiv day in minutes (0..1440), never reaching past `now`. */
export interface StripPart { startMin: number; endMin: number; power: ActualPower }

export interface ActualOutage { start: string; end?: string; startApprox: boolean; endApprox: boolean; ongoing: boolean }

interface Parsed { seg: ActualSegment; start: number; end?: number }

/** Segments with readable times and a non-zero length, in the given order. */
function usable(history: ActualSegment[]): Parsed[] {
  const out: Parsed[] = [];
  for (const seg of history) {
    const start = Date.parse(seg.start);
    const end = seg.end === undefined ? undefined : Date.parse(seg.end);
    if (Number.isNaN(start) || (end !== undefined && (Number.isNaN(end) || end <= start))) continue;
    out.push({ seg, start, end });
  }
  return out;
}

export function dayStrip(history: ActualSegment[], dayKey: string, now: Date): StripPart[] {
  const dayStart = kyivWallTimeToInstant(dayKey, 0).getTime();
  const dayEnd = kyivWallTimeToInstant(addDays(dayKey, 1), 0).getTime();
  const minuteOf = (t: number): number => (t <= dayStart ? 0 : t >= dayEnd ? 1440 : kyivMinutesOfDay(new Date(t)));
  const parts: StripPart[] = [];
  for (const { seg, start, end } of usable(history)) {
    const to = Math.min(end ?? now.getTime(), now.getTime());
    if (to <= dayStart || start >= dayEnd) continue;
    const startMin = minuteOf(start);
    const endMin = minuteOf(to);
    if (endMin > startMin) parts.push({ startMin, endMin, power: seg.power });
  }
  return parts;
}

export function recentOutages(history: ActualSegment[], _now?: Date): ActualOutage[] {
  const outages: ActualOutage[] = [];
  let cur: { start: string; startApprox: boolean } | null = null;
  let gap = false;
  for (const { seg } of usable(history)) {
    if (seg.power === 'off') {
      // off–gap–off is one outage: it keeps the first segment's start.
      cur ??= { start: seg.start, startApprox: seg.startApprox === true };
      gap = false;
    } else if (seg.power === 'unknown') {
      if (cur) gap = true;
    } else if (cur) {
      outages.push({ ...cur, end: seg.start, endApprox: gap || seg.startApprox === true, ongoing: false });
      cur = null; gap = false;
    }
  }
  if (cur) outages.push({ ...cur, endApprox: false, ongoing: !gap });
  return outages.reverse();
}

const approx = (a: boolean): string => (a ? '≈' : '');

/** An outage as its date, time range and duration; `live` while it is still going on. */
export interface OutageParts { date: string; range: string; duration: string; live: boolean }

export function outageParts(o: ActualOutage, now: Date): OutageParts {
  const start = new Date(o.start);
  const date = formatDM(kyivDateKey(start));
  if (o.end !== undefined) {
    const end = new Date(o.end);
    const min = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
    return { date, range: `${approx(o.startApprox)}${formatHM(start)}–${approx(o.endApprox)}${formatHM(end)}`, duration: formatDurationLong(min), live: false };
  }
  const range = `з ${approx(o.startApprox)}${formatHM(start)}`;
  if (!o.ongoing) return { date, range, duration: 'кінець невідомий', live: false };
  const min = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60000));
  return { date, range, duration: `триває ${formatDurationLong(min)}`, live: true };
}

export function formatOutage(o: ActualOutage, now: Date): string {
  const { date, range, duration } = outageParts(o, now);
  return `${date} · ${range} · ${duration}`;
}

export function sinceText(since: string, isApprox: boolean, now: Date): string {
  const t = new Date(since);
  if (Number.isNaN(t.getTime())) return '';
  const key = kyivDateKey(t);
  const hm = `${approx(isApprox)}${formatHM(t)}`;
  return key === kyivDateKey(now) ? `з ${hm}` : `з ${formatDM(key)} ${hm}`;
}
