import type { CurrentOutage, DaySchedule, ScheduleSnapshot, Slot } from './types';
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
}
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
 * logged). It must have started (or have no readable start); a readable end must be in the future; without a readable
 * end it only counts while the snapshot is fresh — an old report must not keep the widget at «Світла немає».
 */
function activeEmergency(o: CurrentOutage | undefined, now: Date, stale: boolean): { outage: CurrentOutage; end?: Date } | null {
  if (!o || o.kind !== 'emergency') return null;
  const start = o.start ? parseDtekDateTime(o.start) : undefined;
  if (start && start.getTime() > now.getTime()) return null;
  const end = o.end ? parseDtekDateTime(o.end) : undefined;
  if (end) return end.getTime() > now.getTime() ? { outage: o, end } : null;
  return stale ? null : { outage: o };
}

function minutesUntil(at: Date, now: Date): number {
  return Math.ceil((at.getTime() - now.getTime()) / 60000);
}

export function computeWidgetView(snapshot: ScheduleSnapshot, now: Date): WidgetView {
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

  const active = activeEmergency(snapshot.currentOutage, now, stale);
  if (active) {
    const badge = badgeFor(active.outage);
    const end = active.end;
    if (end) {
      const left = minutesUntil(end, now);
      return {
        ...base, state: 'emergency', title: TITLES.emergency, outageBadge: badge,
        nextText: `${badge} · орієнтовно до ${formatHM(end)}`,
        countdownShort: formatDurationShort(left), countdownCaption: 'до орієнтовного увімкнення',
      };
    }
    return {
      ...base, state: 'emergency', title: TITLES.emergency, outageBadge: badge,
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
