import type { ActualStatus, CurrentOutage, DaySchedule, ScheduleSnapshot, Slot } from './types';
import { ACTUAL_STALE_MS, dayStrip, sinceText, type StripPart } from './actual-view';
import { addDays, formatHM, kyivDateKey, kyivMinutesOfDay, kyivWallTimeToInstant, parseDtekDateTime } from './time';

export const STALE_AFTER_MIN = 45;
export type PowerState = 'on' | 'off' | 'maybe-off' | 'unknown' | 'emergency';
export interface WidgetView {
  state: PowerState; title: string; nextText: string;
  countdownShort?: string; countdownCaption?: string;
  todayKey: string; today: DaySchedule | null; tomorrow: DaySchedule | null;
  nowFraction: number;
  lineLabel: string;
  updatedText: string;
  stale: boolean; outageBadge?: OutageBadgeText;
  /** The active emergency outage within today, in Kyiv minutes (0..1440), for painting the day strip. */
  emergency?: { startMin: number; endMin: number };
  actual?: WidgetActual; actualUnknownReason?: string; actualStrip?: StripPart[];
}
export interface WidgetActual { power: 'on' | 'off'; sinceText?: string; mismatch: boolean }
export type OutageBadgeText = 'Аварійне' | 'Екстрене';

export function formatDurationLong(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} хв`;
  if (m === 0) return `${h} год`;
  return `${h} год ${m} хв`;
}

export function formatDurationShort(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/** The big countdown; «≈» marks the estimated end of an emergency outage. */
export function countdownText(view: WidgetView): string | undefined {
  if (!view.countdownShort) return undefined;
  return view.state === 'emergency' ? `≈${view.countdownShort}` : view.countdownShort;
}

export function slotRuns(slots: Slot[]): { start: number; end: number; slot: Slot }[] {
  const runs: { start: number; end: number; slot: Slot }[] = [];
  slots.forEach((slot, i) => {
    const last = runs[runs.length - 1];
    if (last && last.slot === slot) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, slot });
  });
  return runs;
}

const TITLES: Record<PowerState, string> = {
  on: 'Світло є',
  off: 'Світла немає',
  'maybe-off': 'Можливе відключення',
  unknown: 'Немає даних',
  emergency: 'Світла немає',
};

function badgeFor(o: CurrentOutage): OutageBadgeText {
  return /екстрен/i.test(o.text) ? 'Екстрене' : 'Аварійне';
}

/**
 * The emergency outage that overrides the schedule right now, if any. Only kind 'emergency' counts ('other' is just
 * logged), and only for the saved queue when the outage names its queues. It must have started (or have no readable
 * start); a readable end must be in the future; without a readable end it only counts while the snapshot is fresh —
 * an old report must not keep the widget at «Світла немає».
 */
function activeEmergency(
  o: CurrentOutage | undefined, groupId: string, now: Date, stale: boolean,
): { outage: CurrentOutage; start?: Date; end?: Date } | null {
  if (!o || o.kind !== 'emergency') return null;
  if (o.groups?.length && !o.groups.includes(groupId)) return null;
  const start = o.start ? parseDtekDateTime(o.start) : undefined;
  if (start && start.getTime() > now.getTime()) return null;
  const end = o.end ? parseDtekDateTime(o.end) : undefined;
  if (end) return end.getTime() > now.getTime() ? { outage: o, start, end } : null;
  return stale ? null : { outage: o, start };
}

/**
 * The emergency's stretch of today in Kyiv minutes. Only what is known is claimed: an unreadable start counts from the
 * current half hour, an unreadable end runs through it — so the current half hour is always inside.
 */
function emergencyWindow(
  start: Date | undefined, end: Date | undefined, todayKey: string, now: Date,
): { startMin: number; endMin: number } {
  const dayStart = kyivWallTimeToInstant(todayKey, 0).getTime();
  const dayEnd = kyivWallTimeToInstant(addDays(todayKey, 1), 0).getTime();
  const minuteOf = (t: Date): number =>
    t.getTime() <= dayStart ? 0 : t.getTime() >= dayEnd ? 1440 : kyivMinutesOfDay(t);
  const cellStart = Math.floor(kyivMinutesOfDay(now) / 30) * 30;
  return { startMin: start ? minuteOf(start) : cellStart, endMin: end ? minuteOf(end) : cellStart + 30 };
}

function minutesUntil(at: Date, now: Date): number {
  return Math.ceil((at.getTime() - now.getTime()) / 60000);
}

function scheduleView(snapshot: ScheduleSnapshot, now: Date): WidgetView {
  const todayKey = kyivDateKey(now);
  const today = snapshot.days.find(d => d.date === todayKey) ?? null;
  const tomorrow = snapshot.days.find(d => d.date === addDays(todayKey, 1)) ?? null;
  const nowMin = kyivMinutesOfDay(now);
  const fetchedAt = new Date(snapshot.fetchedAt);
  const fetchedValid = !Number.isNaN(fetchedAt.getTime());
  // Written as "not fresh" so that an unreadable fetchedAt counts as stale.
  const stale = !(now.getTime() - fetchedAt.getTime() <= STALE_AFTER_MIN * 60000);

  const base = {
    todayKey, today, tomorrow,
    nowFraction: nowMin / 1440,
    lineLabel: `Лінія ${snapshot.address.lineIndex} · ${snapshot.groupLabel.toLowerCase()}`,
    updatedText: `оновлено ${fetchedValid ? formatHM(fetchedAt) : '--:--'}`,
    stale,
  };

  const active = activeEmergency(snapshot.currentOutage, snapshot.address.groupId, now, stale);
  if (active) {
    const badge = badgeFor(active.outage);
    const end = active.end;
    const emergency = emergencyWindow(active.start, end, todayKey, now);
    if (end) {
      const left = minutesUntil(end, now);
      return {
        ...base, state: 'emergency', title: TITLES.emergency, outageBadge: badge, emergency,
        nextText: `${badge} · орієнтовно до ${formatHM(end)}`,
        countdownShort: formatDurationShort(left), countdownCaption: 'до орієнтовного увімкнення',
      };
    }
    return {
      ...base, state: 'emergency', title: TITLES.emergency, outageBadge: badge, emergency,
      nextText: `${badge} відключення · час відновлення невідомий`,
    };
  }

  if (!today) {
    return { ...base, state: 'unknown', title: TITLES.unknown, nextText: 'Графік на сьогодні ще не отримано' };
  }

  const i = Math.floor(nowMin / 30);
  const state: PowerState = today.slots[i] ?? 'unknown';
  const title = TITLES[state];

  const candidates: { dateKey: string; j: number; slot: Slot }[] = [];
  for (let j = i + 1; j < today.slots.length; j++) candidates.push({ dateKey: todayKey, j, slot: today.slots[j] });
  if (tomorrow) tomorrow.slots.forEach((slot, j) => candidates.push({ dateKey: tomorrow.date, j, slot }));

  let change: { dateKey: string; j: number; slot: Slot } | undefined;
  for (const c of candidates) {
    if (c.slot === 'unknown') break;
    if (c.slot !== state) { change = c; break; }
  }
  if (!change) return { ...base, state, title, nextText: 'Без змін до кінця графіка' };

  const at = kyivWallTimeToInstant(change.dateKey, change.j * 30);
  const left = minutesUntil(at, now);
  const hm = formatHM(at);
  const when = `${change.dateKey !== todayKey ? 'завтра ' : ''}о ${hm}`;
  const [lead, caption] =
    change.slot === 'on' ? ['Увімкнуть', `до увімкнення о ${hm}`]
    : change.slot === 'off' ? ['Вимкнення', `до вимкнення о ${hm}`]
    : ['Можливе вимкнення', `до можливого вимкнення о ${hm}`];
  return {
    ...base, state, title,
    nextText: `${lead} ${when} · через ${formatDurationLong(left)}`,
    countdownShort: formatDurationShort(left),
    countdownCaption: caption,
  };
}

/** The schedule view, overridden by a fresh actual reading (spec §6.2). */
export function computeWidgetView(snapshot: ScheduleSnapshot, now: Date, actual?: ActualStatus | null): WidgetView {
  const view = scheduleView(snapshot, now);
  if (!actual) return view;
  const strip = dayStrip(actual.history, view.todayKey, now);
  const observed = Date.parse(actual.observedAt ?? '');
  // Written as "not fresh" so that an unreadable observedAt counts as stale.
  const fresh = actual.power !== 'unknown' && now.getTime() - observed <= ACTUAL_STALE_MS;
  if (!fresh || actual.power === 'unknown') {
    return { ...view, actualUnknownReason: actual.reason ?? 'немає свіжих даних', actualStrip: strip };
  }
  const power = actual.power;
  const since = actual.since && !Number.isNaN(Date.parse(actual.since))
    ? sinceText(actual.since, actual.sinceApprox === true, now) : undefined;
  const mismatch = power === 'off'
    ? view.state === 'on'
    : view.state === 'off' || view.state === 'emergency';
  const state: PowerState = view.state === 'emergency' && power === 'off' ? 'emergency' : power;
  const widgetActual: WidgetActual = { power, ...(since ? { sinceText: since } : {}), mismatch };
  if (!mismatch) return { ...view, state, title: TITLES[state], actual: widgetActual, actualStrip: strip };
  const { countdownShort: _s, countdownCaption: _c, ...rest } = view;
  return {
    ...rest, state, title: TITLES[state],
    nextText: since ? `Не за графіком · ${since}` : 'Не за графіком',
    actual: widgetActual, actualStrip: strip,
  };
}
