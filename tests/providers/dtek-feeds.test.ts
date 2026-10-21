import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  mirrorFeed, yasnoFeed,
  type FeedDeps, type FeedResult,
} from '../../src/main/providers/dtek/feeds';
import { DTEK_QUIET_NOTE, factDays, factToDays, type DtekFact } from '../../src/main/providers/dtek/parse';
import type { HttpResponse } from '../../src/main/providers/http';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { Slot } from '../../src/shared/types';

const fx = (n: string): any => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'dtek-feeds', n), 'utf8'));
const MIRROR = fx('mirror-kyiv-region.json');
const YASNO = fx('yasno-kyiv.json');
const KEM = fx('dtek-kem-fact.json');

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => 'SECRET BODY', arrayBuffer: async () => new ArrayBuffer(0),
});

function deps(respond: () => HttpResponse | Error, extra: Partial<FeedDeps> = {}) {
  const fetch = vi.fn(async () => {
    const r = respond();
    if (r instanceof Error) throw r;
    return r;
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { fetch, log, d: { fetch, isOnline: () => true, log, ...extra } as FeedDeps };
}
const json = (v: unknown) => () => ok(JSON.stringify(v));

const usableAnswer = (r: FeedResult) => {
  expect(r.usable).toBe(true);
  if (!r.usable) throw new Error('unreachable');
  return r.answer;
};

describe('mirror feed', () => {
  const now = new Date('2026-10-21T22:35:00Z');
  const lastUpdated = new Date(MIRROR.lastUpdated).getTime();
  const read = (body: unknown, at: Date = now, group = 'GPV1.1') => {
    const t = deps(json(body));
    return mirrorFeed('kyiv-region', t.d).read(group, at);
  };

  it('mirror: usable copy', async () => {
    const t = deps(json(MIRROR));
    const r = await mirrorFeed('kyiv-region', t.d).read('GPV1.1', now);
    const a = usableAnswer(r);
    expect(a.days).toEqual(factDays(MIRROR.fact, 'GPV1.1', '2026-10-22').days);
    expect(a.sourceUpdatedAt).toBe('21.10.2026 19:20');
    expect(a.groupLabel).toBe(MIRROR.preset.sch_names['GPV1.1']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('mirror: stale after 30 min', async () => {
    expect((await read(MIRROR, new Date(lastUpdated + 31 * 60_000))).usable).toBe(false);
    expect((await read(MIRROR, new Date(lastUpdated + 29 * 60_000))).usable).toBe(true);
  });

  it('mirror: lastUpdated in the future', async () => {
    expect((await read(MIRROR, new Date(lastUpdated - 6 * 60_000))).usable).toBe(false);
    expect((await read(MIRROR, new Date(lastUpdated - 4 * 60_000))).usable).toBe(true);
  });

  it('mirror scraped before midnight', async () => {
    const old = structuredClone(MIRROR);
    old.fact.today = 1792530000;
    old.lastUpdated = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect((await read(old)).usable).toBe(false);
  });

  it('mirror: queue absent', async () => {
    expect((await read(MIRROR, now, 'GPV9.9')).usable).toBe(false);
  });

  it('mirror: quiet day', async () => {
    const quiet = structuredClone(MIRROR);
    quiet.fact.data = {};
    const a = usableAnswer(await read(quiet));
    expect(a.days).toEqual([{ date: '2026-10-22', slots: Array<Slot>(48).fill('on') }]);
    expect(a.note).toBe(DTEK_QUIET_NOTE);
  });

  it('mirror: unreadable shapes', async () => {
    const noStamp = structuredClone(MIRROR); delete noStamp.lastUpdated;
    const arrayData = structuredClone(MIRROR); arrayData.fact.data = [];
    const noNames = structuredClone(MIRROR); delete noNames.preset.sch_names;
    for (const body of [noStamp, arrayData, noNames]) {
      const err = await read(body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).not.toBeInstanceOf(NetworkError);
    }
  });

  it('HTML body', async () => {
    const t = deps(() => ok('<html>Incapsula</html>'));
    const err = await mirrorFeed('kyiv', t.d).read('GPV1.1', now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(NetworkError);
  });

  it('HTTP 500', async () => {
    const t = deps(() => failStatus(500));
    const err = await mirrorFeed('kyiv', t.d).read('GPV1.1', now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(JSON.stringify(t.log.error.mock.calls, (_, v: unknown) => (v instanceof Error ? { m: v.message, c: v.cause } : v)))
      .not.toContain('SECRET');
  });

  it('fetch throws while offline', async () => {
    const t = deps(() => new TypeError('net'), { isOnline: () => false });
    await expect(mirrorFeed('kyiv', t.d).read('GPV1.1', now)).rejects.toBeInstanceOf(NetworkError);
  });

  it('cache', async () => {
    let t0 = 1_000_000;
    let fail = false;
    const t = deps(() => (fail ? failStatus(500) : ok(JSON.stringify(MIRROR))), { clock: () => t0 });
    const feed = mirrorFeed('kyiv-region', t.d);
    await feed.read('GPV1.1', now);
    t0 += 60_000;
    await feed.read('GPV1.1', now);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t0 += 61_000; // 121 s after the first read
    fail = true;
    await expect(feed.read('GPV1.1', now)).rejects.toBeInstanceOf(ProviderError);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    fail = false;
    await feed.read('GPV1.1', now); // the failure was not cached
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('yasno feed', () => {
  const now = new Date('2026-10-21T22:36:00Z');
  const kemFact = KEM.fact as DtekFact;
  const read = (body: unknown, group: string, at: Date = now) => {
    const t = deps(json(body));
    return { t, result: yasnoFeed(t.d).read(group, at) };
  };
  /** The 20.1 entry with today / tomorrow replaced. */
  const entry = (patch: { today?: object; tomorrow?: object }) => {
    const body = structuredClone(YASNO);
    Object.assign(body['20.1'].today, patch.today);
    Object.assign(body['20.1'].tomorrow, patch.tomorrow);
    return body;
  };

  it('yasno equals DTEK-KEM', async () => {
    for (const k of ['1.1', '19.1', '20.1', '60.1']) {
      const a = usableAnswer(await read(YASNO, 'GPV' + k).result);
      expect(a.days).toEqual(factToDays(kemFact, 'GPV' + k));
      expect(a.days).toHaveLength(1);
      expect(a.sourceUpdatedAt).toBe('20:45 21.10.2026');
    }
  });

  it('yasno: groupId mapping', async () => {
    for (const g of ['20.1', 'none', 'GPV99.1']) expect((await read(YASNO, g).result).usable).toBe(false);
  });

  it('yasno: statuses', async () => {
    const quiet = usableAnswer(await read(entry({ today: { status: 'NoOutages', slots: [] } }), 'GPV20.1').result);
    expect(quiet.days[0]).toEqual({ date: '2026-10-22', slots: Array<Slot>(48).fill('on') });
    expect(quiet.note).toBe(DTEK_QUIET_NOTE);
    expect(await read(entry({ today: { status: 'EmergencyShutdowns' } }), 'GPV20.1').result)
      .toMatchObject({ usable: false, emergency: true });
    expect((await read(entry({ today: { status: 'WaitingForSchedule' } }), 'GPV20.1').result).usable).toBe(false);
  });

  it("yasno: today's date must be today", async () => {
    const r = await read(entry({ today: { date: '2026-10-21T00:00:00+03:00' } }), 'GPV20.1').result;
    expect(r.usable).toBe(false);
  });

  it('yasno: tomorrow', async () => {
    const slots = [{ start: 0, end: 1440, type: 'NotPlanned' }];
    const applies = { status: 'ScheduleApplies', slots };
    const a = usableAnswer(await read(entry({ tomorrow: { ...applies, date: '2026-10-23T00:00:00+03:00' } }), 'GPV20.1').result);
    expect(a.days.map((d) => d.date)).toEqual(['2026-10-22', '2026-10-23']);
    const b = usableAnswer(await read(entry({ tomorrow: { ...applies, date: '2026-10-24T00:00:00+03:00' } }), 'GPV20.1').result);
    expect(b.days.map((d) => d.date)).toEqual(['2026-10-22']);
  });

  it('DST tomorrow', async () => {
    const body = entry({
      today: { date: '2026-10-25T00:00:00+03:00' },
      tomorrow: { status: 'ScheduleApplies', date: '2026-10-26T00:00:00+02:00', slots: [{ start: 0, end: 1440, type: 'NotPlanned' }] },
    });
    const a = usableAnswer(await read(body, 'GPV20.1', new Date('2026-10-25T09:00:00Z')).result);
    expect(a.days.map((d) => d.date)).toEqual(['2026-10-25', '2026-10-26']);
  });

  describe('yasno: slot conversion', () => {
    const today = async (slots: object[]) => usableAnswer(
      await read(entry({ today: { status: 'ScheduleApplies', slots } }), 'GPV20.1').result,
    ).days[0].slots;

    it('Definite and NotPlanned', async () => {
      const s = await today([{ start: 0, end: 45, type: 'Definite' }, { start: 45, end: 1440, type: 'NotPlanned' }]);
      expect(s.slice(0, 2)).toEqual(['off', 'off']);
      expect(s.slice(2)).toEqual(Array(46).fill('on'));
    });

    it('a gap is unknown', async () => {
      const s = await today([{ start: 0, end: 600, type: 'NotPlanned' }, { start: 660, end: 1440, type: 'NotPlanned' }]);
      expect(s[19]).toBe('on');
      expect(s.slice(20, 22)).toEqual(['unknown', 'unknown']);
      expect(s[22]).toBe('on');
    });

    it('an unknown type is unknown and logged', async () => {
      const r = read(
        entry({ today: { status: 'ScheduleApplies', slots: [{ start: 0, end: 600, type: 'NotPlanned' }, { start: 600, end: 660, type: 'Possible' }, { start: 660, end: 1440, type: 'NotPlanned' }] } }),
        'GPV20.1',
      );
      const s = usableAnswer(await r.result).days[0].slots;
      expect(s.slice(20, 22)).toEqual(['unknown', 'unknown']);
      expect(r.t.log.warn).toHaveBeenCalled();
    });
  });

  it('yasno: unreadable', async () => {
    await expect(read([], 'GPV20.1').result).rejects.toBeInstanceOf(ProviderError);
    const bad = entry({ today: { slots: 'x' } });
    await expect(read(bad, 'GPV20.1').result).rejects.toBeInstanceOf(ProviderError);
  });
});
