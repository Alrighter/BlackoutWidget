import type { CurrentOutage, DaySchedule, HouseInfo, LineInfo, Slot } from '../../../shared/types';
import { kyivDateKey } from '../../../shared/time';
import { ProviderError } from '../types';

export interface DtekFact { data: Record<string, Record<string, Record<string, string>>>; update: string; today: number }
export interface DtekHouseEntry { sub_type: string; start_date: string; end_date: string; type: string; sub_type_reason: string[]; voluntarily: unknown; cek: unknown }
export interface DtekHomeNumResponse { result: boolean; data: Record<string, DtekHouseEntry>; updateTimestamp?: string; fact?: DtekFact; preset?: { sch_names: Record<string, string> } }

export function parseHomeNumResponse(json: unknown): DtekHomeNumResponse {
  const o = json as Partial<DtekHomeNumResponse> | null;
  if (typeof o !== 'object' || o === null || o.result !== true || typeof o.data !== 'object' || o.data === null) {
    throw new ProviderError('Unexpected DTEK response');
  }
  return o as DtekHomeNumResponse;
}

export function hourToSlots(status: string): [Slot, Slot] {
  switch (status) {
    case 'yes': return ['on', 'on'];
    case 'no': return ['off', 'off'];
    case 'first': return ['off', 'on'];
    case 'second': return ['on', 'off'];
    case 'maybe': return ['maybe-off', 'maybe-off'];
    case 'mfirst': return ['maybe-off', 'on'];
    case 'msecond': return ['on', 'maybe-off'];
    default: return ['unknown', 'unknown'];
  }
}

const KNOWN_STATUSES = new Set(['yes', 'no', 'first', 'second', 'maybe', 'mfirst', 'msecond']);

/** `onUnknownStatus` is told about every hour status the mapping does not know (it becomes `unknown` slots). */
export function factToDays(fact: DtekFact, groupId: string, onUnknownStatus?: (status: string) => void): DaySchedule[] {
  const days: DaySchedule[] = [];
  for (const [ts, groups] of Object.entries(fact.data)) {
    const hours = groups[groupId];
    if (!hours) continue;
    const slots: Slot[] = [];
    for (let h = 1; h <= 24; h++) {
      const status = hours[String(h)];
      if (status !== undefined && !KNOWN_STATUSES.has(status)) onUnknownStatus?.(String(status));
      slots.push(...(status === undefined ? (['unknown', 'unknown'] as [Slot, Slot]) : hourToSlots(status)));
    }
    days.push({ date: kyivDateKey(new Date(Number(ts) * 1000)), slots });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export function deriveLines(subTypeReason: string[], fact: DtekFact, schNames: Record<string, string>): LineInfo[] {
  const days = Object.values(fact.data);
  return subTypeReason
    .slice(0, 2)
    .filter(key => days.every(d => key in d) && key in schNames)
    .map((groupId, i) => ({ index: i + 1, groupId, label: schNames[groupId] }));
}

export function parseHouses(resp: DtekHomeNumResponse, fact: DtekFact, schNames: Record<string, string>): HouseInfo[] {
  return Object.entries(resp.data).map(([house, entry]) => ({
    house,
    lines: deriveLines(entry.sub_type_reason ?? [], fact, schNames),
    outageActive: hasActiveOutage(entry),
  }));
}

/** 'Черга 1.2' for 'GPV1.2' when the source's own name for the queue is missing. */
export function queueLabelFromId(groupId: string): string {
  const m = /(\d+(?:\.\d+)*)$/.exec(groupId);
  return m ? `Черга ${m[1]}` : groupId;
}

const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * The source reports a current outage for the house (type or sub_type filled). While it does, `sub_type_reason`
 * lists the queues of that outage, not the house's queues (seen live on 2026-10-17).
 */
export function hasActiveOutage(entry: DtekHouseEntry): boolean {
  return !blank(entry.type) || !blank(entry.sub_type);
}

const OUTAGE_FIELDS = ['type', 'sub_type', 'start_date', 'end_date', 'voluntarily', 'cek'] as const;

/** True when any field that may describe a current outage is filled (non-empty string / non-null value): worth logging raw. */
export function hasOutageFields(entry: DtekHouseEntry): boolean {
  return OUTAGE_FIELDS.some(k => !blank(entry[k]));
}

export function parseCurrentOutage(entry: DtekHouseEntry): CurrentOutage | undefined {
  // `type` has been seen as a bare numeric code ("2"); only a real text type belongs in the message.
  const type = typeof entry.type === 'string' && !/^\s*\d+\s*$/.test(entry.type) ? entry.type.trim() : '';
  const sub = typeof entry.sub_type === 'string' ? entry.sub_type.trim() : '';
  const text = [type, sub].filter(Boolean).join(' · ');
  if (!text) return undefined;
  const groups = Array.isArray(entry.sub_type_reason) ? entry.sub_type_reason.filter(g => typeof g === 'string') : [];
  const out: CurrentOutage = { kind: /аварій|екстрен/i.test(text) ? 'emergency' : 'other', text, groups };
  if (entry.start_date) out.start = entry.start_date;
  if (entry.end_date) out.end = entry.end_date;
  return out;
}

export const DTEK_QUIET_NOTE = 'ДТЕК не опублікував графік на сьогодні — зазвичай це означає, що відключень за графіком немає';

/**
 * The source answered normally (it stamped its update) but published no schedule for today for any group:
 * between outage waves that means no scheduled outages. A blank stamp means an unreadable answer, never a quiet day.
 */
export function isQuietToday(fact: DtekFact, todayKey: string): boolean {
  if (typeof fact.update !== 'string' || fact.update.trim() === '') return false;
  return !Object.keys(fact.data ?? {}).some(ts => kyivDateKey(new Date(Number(ts) * 1000)) === todayKey);
}
