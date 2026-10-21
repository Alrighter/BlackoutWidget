import { silentLogger, type Logger } from '../../log';
import type { DaySchedule, Slot } from '../../../shared/types';
import { addDays, dtekStamp, kyivDateKey } from '../../../shared/time';
import type { HttpFetch } from '../http';
import { HttpSource, sourceTexts } from '../http-source';
import { instant, isObj } from '../shape';
import { DTEK_QUIET_NOTE, factDays } from './parse';
import type { DtekFact } from './parse';

/** A mirror file older than this (by its own `lastUpdated`) is not trusted; its history: a run every 5 min, worst gap 18 min. */
export const MIRROR_MAX_AGE_MS = 30 * 60_000;
/** A `lastUpdated` further ahead than this is a clock we cannot trust. */
export const MIRROR_FUTURE_SLACK_MS = 5 * 60_000;
/** How long a feed keeps its last good body, so two locations on one site make one request. */
export const FEED_CACHE_MS = 2 * 60_000;
/** The least time between two automatic opens of the DTEK page, per site. */
export const PAGE_GAP_MS = 30 * 60_000;
/** How long the DTEK page window stays after its last operation. */
export const PAGE_LINGER_MS = 5 * 60_000;
/** How often the house is checked on the DTEK page. */
export const HOUSE_CHECK_MS = 24 * 60 * 60_000;
/** A house check that finds the house missing is surfaced once the last good check is older than this. */
export const HOUSE_MISSING_SURFACE_MS = 48 * 60 * 60_000;
/** The refresh error when no feed answered and the page was not allowed. */
export const FEEDS_FAILED_TEXT = 'Не вдалося отримати графік ДТЕК';

export interface FeedAnswer { days: DaySchedule[]; sourceUpdatedAt?: string; note?: string; groupLabel?: string }
export type FeedResult = { usable: true; answer: FeedAnswer } | { usable: false; reason: string; emergency?: boolean };

/** One HTTP JSON copy of a DTEK site's schedule for every queue. Request or shape failures throw ProviderError / NetworkError. */
export interface ScheduleFeed { readonly tag: string; read(groupId: string, now: Date): Promise<FeedResult> }

export interface FeedDeps { fetch: HttpFetch; isOnline: () => boolean; log: Logger; clock?: () => number }

const MIRROR_BASE = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data';
const YASNO_URL = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';

const unusable = (reason: string): FeedResult => ({ usable: false, reason });

/**
 * A feed's request plumbing and its two-minute cache of the last good parsed body (a failure is never cached). `parse`
 * runs once per fetched body, so what it logs is logged once per body, not on every read.
 */
function cachedBody<T>(
  tag: string, url: string, deps: FeedDeps, parse: (json: unknown, source: HttpSource) => T,
): () => Promise<T> {
  const clock = deps.clock ?? Date.now;
  // The source's own error log is silenced: the route logs a failed feed once, as a warning, with `loggable`.
  const source = new HttpSource({
    fetch: deps.fetch, isOnline: deps.isOnline, log: silentLogger, tag, texts: sourceTexts('джерела графіків ДТЕК'), clock,
  });
  let cached: { at: number; body: T } | undefined;
  return () => source.serial('fetch', async () => {
    if (cached && clock() - cached.at < FEED_CACHE_MS) return cached.body;
    const body = parse(await source.json(url), source);
    cached = { at: clock(), body };
    return body;
  });
}

interface MirrorBody { lastUpdated: Date; fact: DtekFact; schNames: Record<string, string> }

export function mirrorFeed(file: 'kyiv' | 'kyiv-region' | 'dnipro' | 'odesa', deps: FeedDeps): ScheduleFeed {
  const tag = `mirror ${file}`;
  const load = cachedBody<MirrorBody>(tag, `${MIRROR_BASE}/${file}.json`, deps, (json, source) => {
    const fail = (reason: string): never => { throw source.unreadable({ what: 'mirror', reason }); };
    if (!isObj(json)) return fail('not an object');
    const lastUpdated = instant(json.lastUpdated);
    if (!lastUpdated) return fail('lastUpdated');
    const { fact, preset } = json;
    if (!isObj(fact) || !isObj(fact.data) || typeof fact.update !== 'string' || typeof fact.today !== 'number') return fail('fact');
    if (!isObj(preset) || !isObj(preset.sch_names)) return fail('preset');
    return { lastUpdated, fact: fact as unknown as DtekFact, schNames: preset.sch_names as Record<string, string> };
  });
  return {
    tag,
    async read(groupId, now) {
      const { lastUpdated, fact, schNames } = await load();
      const age = now.getTime() - lastUpdated.getTime();
      if (age > MIRROR_MAX_AGE_MS) return unusable('stale');
      if (age < -MIRROR_FUTURE_SLACK_MS) return unusable('lastUpdated in the future');
      const todayKey = kyivDateKey(now);
      if (kyivDateKey(new Date(fact.today * 1000)) !== todayKey) return unusable('not today');
      if (Object.keys(fact.data).length > 0 && !Object.values(fact.data).some((day) => isObj(day) && groupId in day)) {
        return unusable('queue absent');
      }
      let unknownStatuses = 0;
      const { days, note } = factDays(fact, groupId, todayKey, () => { unknownStatuses++; });
      if (unknownStatuses > 0) deps.log.warn(`${tag}: unknown hour statuses`, { count: unknownStatuses });
      const answer: FeedAnswer = { days, sourceUpdatedAt: fact.update };
      if (note !== undefined) answer.note = note;
      const label = schNames[groupId];
      if (typeof label === 'string') answer.groupLabel = label;
      return { usable: true, answer };
    },
  };
}

interface YasnoRange { start: number; end: number; type: string }
/** A day as parsed: `dateKey` is the Kyiv date of its `date` instant (undefined when unreadable), `slots` already converted. */
interface YasnoDay { dateKey: string | undefined; status: string; slots: Slot[] }
interface YasnoEntry { today: YasnoDay; tomorrow?: YasnoDay; updatedOn?: string }

/**
 * Half-hour i covers [30i, 30i+30): `off` when a Definite range touches it, `on` when NotPlanned covers all of it, else
 * `unknown`. A range of another type covers nothing and is counted through `onUnknown`.
 */
function slotsOf(ranges: YasnoRange[], onUnknown: () => void): Slot[] {
  const definite = new Array<boolean>(1440).fill(false);
  const planned = new Array<boolean>(1440).fill(false);
  for (const r of ranges) {
    const mask = r.type === 'Definite' ? definite : r.type === 'NotPlanned' ? planned : undefined;
    if (!mask) { onUnknown(); continue; }
    for (let m = Math.max(0, r.start); m < Math.min(1440, r.end); m++) mask[m] = true;
  }
  return Array.from({ length: 48 }, (_, i): Slot => {
    const half = (mask: boolean[]) => mask.slice(30 * i, 30 * i + 30);
    if (half(definite).some(Boolean)) return 'off';
    return half(planned).every(Boolean) ? 'on' : 'unknown';
  });
}

export function yasnoFeed(deps: FeedDeps): ScheduleFeed {
  const tag = 'yasno';
  const load = cachedBody<Record<string, YasnoEntry>>(tag, YASNO_URL, deps, (json, source) => {
    const fail = (reason: string): never => { throw source.unreadable({ what: 'yasno', reason }); };
    if (!isObj(json)) return fail('not an object');
    let unknownTypes = 0;
    const day = (v: unknown): YasnoDay => {
      if (!isObj(v) || typeof v.date !== 'string' || typeof v.status !== 'string' || !Array.isArray(v.slots)) return fail('day');
      for (const s of v.slots) {
        if (!isObj(s) || typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.type !== 'string') return fail('slot');
      }
      const at = instant(v.date);
      return {
        dateKey: at && kyivDateKey(at), status: v.status,
        slots: slotsOf(v.slots as YasnoRange[], () => { unknownTypes++; }),
      };
    };
    const out: Record<string, YasnoEntry> = {};
    for (const [key, e] of Object.entries(json)) {
      if (!isObj(e)) return fail('entry');
      out[key] = {
        today: day(e.today),
        tomorrow: e.tomorrow === undefined ? undefined : day(e.tomorrow),
        updatedOn: typeof e.updatedOn === 'string' ? e.updatedOn : undefined,
      };
    }
    // Once per parsed body, and a count only: the type names are response text.
    if (unknownTypes > 0) deps.log.warn(`${tag}: unknown slot types`, { count: unknownTypes });
    return out;
  });

  return {
    tag,
    async read(groupId, now) {
      const key = /^GPV(\d+\.\d+)$/.exec(groupId)?.[1];
      if (key === undefined) return unusable('groupId not mapped');
      const entry = (await load())[key];
      if (!entry) return unusable('queue absent');
      const todayKey = kyivDateKey(now);
      const { today, tomorrow } = entry;
      if (today.dateKey !== todayKey) return unusable('not today');
      if (today.status === 'EmergencyShutdowns') return { usable: false, reason: 'emergency', emergency: true };
      const days: DaySchedule[] = [];
      let note: string | undefined;
      if (today.status === 'ScheduleApplies') {
        days.push({ date: todayKey, slots: [...today.slots] }); // a copy: the cached body stays as parsed
      } else if (today.status === 'NoOutages') {
        days.push({ date: todayKey, slots: Array<Slot>(48).fill('on') });
        note = DTEK_QUIET_NOTE;
      } else {
        return unusable('waiting for schedule');
      }
      const tomorrowKey = addDays(todayKey, 1);
      if (tomorrow && tomorrow.status === 'ScheduleApplies' && tomorrow.dateKey === tomorrowKey) {
        days.push({ date: tomorrowKey, slots: [...tomorrow.slots] });
      }
      const answer: FeedAnswer = { days };
      const updated = instant(entry.updatedOn);
      if (updated) answer.sourceUpdatedAt = dtekStamp(updated); // DTEK's order: the footer reads alike for every source
      if (note !== undefined) answer.note = note;
      return { usable: true, answer };
    },
  };
}
