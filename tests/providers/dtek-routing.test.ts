import stale from '../fixtures/dtek/getHomeNum-stale-updateFact.json';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DtekProvider, FEEDS_FAILED_TEXT } from '../../src/main/providers/dtek';
import {
  PAGE_LINGER_MS, PAGE_REFRESH_LINGER_MS, mirrorFeed, type FeedAnswer, type FeedResult,
} from '../../src/main/providers/dtek/feeds';
import { READ_FACT, getHomeNumScript, readStreetsScript } from '../../src/main/providers/dtek/page-scripts';
import { factToDays } from '../../src/main/providers/dtek/parse';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { CaptchaRequiredError, NetworkError, ProviderError } from '../../src/main/providers/types';
import { RefreshService } from '../../src/main/refresh';
import { AppStore } from '../../src/main/store';
import type { Address, CurrentOutage, ScheduleSnapshot, Slot } from '../../src/shared/types';

const KREM = { id: 'dtek-krem', cityLevel: true };
const C = 'м. Біла Церква', S = 'бул. Грушевського Михайла';
const addr: Address = { providerId: 'dtek-krem', city: C, street: S, house: '40', lineIndex: 1, groupId: 'GPV1.2' };
const HOME_NUM = getHomeNumScript(C, S, '17.10.2026 11:55');
const MIN = 60_000, HOUR = 60 * MIN;
/** The fixture's day: the tests that assert the page path's days run on it. */
const FIXTURE_DAY = new Date('2026-10-17T09:00:00Z');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T22:35:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const nowIso = () => new Date().toISOString();

/** dtek-provider.test.ts's fake plus a window: open after ensureReady, closed after release. `opens` counts the builds. */
function fakeSession(body: unknown = stale) {
  const s = {
    open: false,
    opens: 0,
    ensureReady: vi.fn(async () => { if (!s.open) s.opens++; s.open = true; }),
    showForUser: vi.fn(async () => { if (!s.open) s.opens++; s.open = true; }),
    reload: vi.fn(async () => {}),
    isOnline: vi.fn(() => true),
    isOpen: vi.fn(() => s.open),
    release: vi.fn(() => { s.open = false; }),
    dispose: vi.fn(),
    evaluate: vi.fn(async (js: string): Promise<unknown> => {
      if (js === READ_FACT) return { fact: stale.fact, schNames: stale.preset.sch_names };
      if (js === HOME_NUM) return { status: 200, body: JSON.stringify(body) };
      if (js === readStreetsScript(C)) return [S];
      throw new Error('unexpected ' + js.slice(0, 60));
    }),
  };
  return s;
}
/** The next ensureReady builds the window and then fails its load: as in BrowserSession, the window stays open. */
function failedLoad(s: ReturnType<typeof fakeSession>, err: Error) {
  s.ensureReady.mockImplementationOnce(async () => { if (!s.open) s.opens++; s.open = true; throw err; });
}
const readFacts = (s: ReturnType<typeof fakeSession>) => s.evaluate.mock.calls.filter(c => c[0] === READ_FACT).length;
const homeNums = (s: ReturnType<typeof fakeSession>) => s.evaluate.mock.calls.filter(c => c[0] === HOME_NUM).length;

const FEED_DAYS = [{ date: '2026-10-22', slots: Array<Slot>(48).fill('off') }];
const answer = (over: Partial<FeedAnswer> = {}): FeedResult => (
  { usable: true, answer: { days: FEED_DAYS, sourceUpdatedAt: '21.10.2026 19:20', ...over } });
const unusable = (reason: string): FeedResult => ({ usable: false, reason });
function feed(tag: string, result: FeedResult | Error) {
  return { tag, read: vi.fn(async (_groupId: string, _now: Date): Promise<FeedResult> => { if (result instanceof Error) throw result; return result; }) };
}
function fakeLog() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

const LINES = [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }, { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' }];
function snap(o: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return { providerId: 'dtek-krem', address: addr, groupId: 'GPV1.2', groupLabel: 'Черга 1.2', days: [], fetchedAt: ago(15 * MIN), lines: LINES, ...o };
}
const fresh = () => snap({ houseCheckedAt: ago(HOUR) });

function provider(s = fakeSession(), feeds = [feed('mirror kyiv-region', answer())]) {
  const log = fakeLog();
  return { p: new DtekProvider(KREM, s as any, log, { feeds }), s, feeds, log };
}
/** A wizard step opens the page; the linger releases it at 5 min; it is now 10 min after the open. */
async function pageClosedRecently(p: DtekProvider) {
  await p.listStreets(C);
  await vi.advanceTimersByTimeAsync(10 * MIN);
}

test('no previous → the page path, with houseCheckedAt now', async () => {
  vi.setSystemTime(FIXTURE_DAY);
  const { p, s, feeds, log } = provider();
  const snapshot = await p.fetchSnapshot(addr, null);
  expect(homeNums(s)).toBe(1);
  expect(snapshot.houseCheckedAt).toBe(FIXTURE_DAY.toISOString());
  expect(snapshot.fetchedAt).toBe(FIXTURE_DAY.toISOString());
  expect(snapshot.days).toEqual(factToDays(stale.fact as any, 'GPV1.2'));
  expect(snapshot.sourceUpdatedAt).toBe('17.10.2026 11:55');
  expect(snapshot.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
  expect(feeds[0].read).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledWith('dtek-krem: using the page', { reason: 'house check' });
});

test('a fresh house check → the feed, the page untouched', async () => {
  const { p, s, feeds } = provider();
  const outage: CurrentOutage = { kind: 'emergency', text: 'Аварійне відключення', end: '23:30 21.10.2026' };
  const previous = snap({ houseCheckedAt: ago(HOUR), outageActive: false, currentOutage: outage, groupLabel: 'Черга 1.2 (збережена)' });
  const snapshot = await p.fetchSnapshot(addr, previous);
  expect(s.ensureReady).not.toHaveBeenCalled();
  expect(s.evaluate).not.toHaveBeenCalled();
  expect(feeds[0].read).toHaveBeenCalledWith('GPV1.2', new Date());
  expect(snapshot).toStrictEqual({
    providerId: 'dtek-krem', address: addr, groupId: 'GPV1.2', groupLabel: 'Черга 1.2 (збережена)',
    days: FEED_DAYS, sourceUpdatedAt: '21.10.2026 19:20', fetchedAt: nowIso(),
    lines: LINES, outageActive: false, currentOutage: outage, houseCheckedAt: previous.houseCheckedAt,
  });
  // No page use, so no linger either.
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).not.toHaveBeenCalled();
});

test.each([
  ['25 h old', 25 * HOUR],
  ['exactly 24 h old', 24 * HOUR],
  ['1 h in the future', -HOUR],
])('a house check %s → the page', async (_name, age) => {
  const { p, s, feeds } = provider();
  const snapshot = await p.fetchSnapshot(addr, snap({ houseCheckedAt: ago(age) }));
  expect(homeNums(s)).toBe(1);
  expect(feeds[0].read).not.toHaveBeenCalled();
  expect(snapshot.houseCheckedAt).toBe(nowIso());
});
test('a previous without houseCheckedAt (an older build) → the page', async () => {
  const { p, s, feeds } = provider();
  expect((await p.fetchSnapshot(addr, snap())).houseCheckedAt).toBe(nowIso());
  expect(homeNums(s)).toBe(1);
  expect(feeds[0].read).not.toHaveBeenCalled();
});

test('an outage at the last check → the page, every refresh within the budget', async () => {
  const { p, s, feeds } = provider();
  const previous = snap({ houseCheckedAt: ago(HOUR), outageActive: true });
  await p.fetchSnapshot(addr, previous); // t = 0: the page opens
  await vi.advanceTimersByTimeAsync(MIN / 2);
  const again = await p.fetchSnapshot(addr, previous); // t = 30 s: still open, so free
  expect(homeNums(s)).toBe(2);
  expect(again.houseCheckedAt).toBe(nowIso());
  expect(feeds[0].read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(PAGE_REFRESH_LINGER_MS); // t = 90 s: released
  expect(s.release).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(8.5 * MIN); // t = 10 min: closed and opened 10 min ago
  const fromFeed = await p.fetchSnapshot(addr, previous);
  expect(feeds[0].read).toHaveBeenCalledTimes(1);
  expect(fromFeed.days).toEqual(FEED_DAYS);
  expect(fromFeed).toMatchObject({ outageActive: true, houseCheckedAt: previous.houseCheckedAt });
  expect(s.opens).toBe(1);
  await vi.advanceTimersByTimeAsync(20 * MIN); // t = 30 min since the open: allowed again
  await p.fetchSnapshot(addr, previous);
  expect(s.opens).toBe(2);
  expect(feeds[0].read).toHaveBeenCalledTimes(1);
});

test('a house check that hits a verification, while the feed answers → the feed\'s snapshot, no throw', async () => {
  const s = fakeSession();
  s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  const { p, log } = provider(s);
  const previous = snap({ houseCheckedAt: ago(25 * HOUR) });
  const snapshot = await p.fetchSnapshot(addr, previous);
  expect(snapshot.days).toEqual(FEED_DAYS);
  expect(snapshot.houseCheckedAt).toBe(previous.houseCheckedAt);
  expect(log.warn).toHaveBeenCalledWith('dtek-krem: the page failed (house check), using mirror kyiv-region', expect.any(CaptchaRequiredError));
  expect(log.error).not.toHaveBeenCalled();
});

test('the first feed unusable → the second feed', async () => {
  const a = feed('yasno', unusable('waiting for schedule'));
  const b = feed('mirror kyiv', answer({ note: 'тихий день', groupLabel: 'Черга 1.2 (ДТЕК)' }));
  const { p, log } = provider(fakeSession(), [a, b]);
  const snapshot = await p.fetchSnapshot(addr, fresh());
  expect(a.read).toHaveBeenCalledTimes(1);
  expect(b.read).toHaveBeenCalledTimes(1);
  expect(a.read.mock.invocationCallOrder[0]).toBeLessThan(b.read.mock.invocationCallOrder[0]);
  expect(snapshot).toMatchObject({ days: FEED_DAYS, note: 'тихий день', groupLabel: 'Черга 1.2 (ДТЕК)' });
  expect(log.warn).toHaveBeenCalledWith('dtek-krem: yasno unusable', { reason: 'waiting for schedule' });
});
test('a feed that rejects is logged without its message and the next one is tried', async () => {
  const a = feed('yasno', new TypeError('<html>SECRET BODY</html>'));
  const b = feed('mirror kyiv', new ProviderError('Не вдалося прочитати відповідь джерела графіків ДТЕК'));
  const c = feed('mirror kyiv-region', answer());
  const { p, log } = provider(fakeSession(), [a, b, c]);
  expect((await p.fetchSnapshot(addr, fresh())).days).toEqual(FEED_DAYS);
  expect(log.warn).toHaveBeenCalledWith('dtek-krem: yasno failed', { error: 'TypeError' });
  expect(log.warn).toHaveBeenCalledWith('dtek-krem: mirror kyiv failed', expect.any(ProviderError));
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET');
});

test('a real feed whose request fails is logged once, as the route\'s warning, never at error', async () => {
  const log = fakeLog();
  const fetch = vi.fn(async () => ({
    ok: false, status: 500, text: async () => 'SECRET BODY', arrayBuffer: async () => new ArrayBuffer(0),
  }));
  const mirror = mirrorFeed('kyiv-region', { fetch, isOnline: () => true, log });
  const p = new DtekProvider(KREM, fakeSession() as any, log, { feeds: [mirror, feed('mirror kyiv', answer())] });
  expect((await p.fetchSnapshot(addr, fresh())).days).toEqual(FEED_DAYS);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(log.error).not.toHaveBeenCalled();
  const failedWarns = log.warn.mock.calls.filter(c => c[0] === 'dtek-krem: mirror kyiv-region failed');
  expect(failedWarns).toHaveLength(1);
  expect(failedWarns[0][1]).toBeInstanceOf(ProviderError);
  expect((failedWarns[0][1] as ProviderError).cause).toEqual({ url: expect.stringContaining('kyiv-region.json'), status: 500 });
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET');
});

test('yasno emergency → the page', async () => {
  const yasno = () => feed('yasno', { usable: false, reason: 'emergency', emergency: true });
  const mirror = () => feed('mirror kyiv', answer());
  {
    const y = yasno(), m = mirror();
    const { p, s, log } = provider(fakeSession(), [y, m]);
    const snapshot = await p.fetchSnapshot(addr, fresh());
    expect(homeNums(s)).toBe(1);
    expect(snapshot.houseCheckedAt).toBe(nowIso());
    expect(m.read).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('dtek-krem: using the page', { reason: 'emergency' });
  }
  { // the page fails: the second feed's answer
    const s = fakeSession();
    s.ensureReady.mockRejectedValue(new ProviderError('Сайт ДТЕК не відповідає'));
    const y = yasno(), m = mirror();
    const { p, log } = provider(s, [y, m]);
    const previous = fresh();
    const snapshot = await p.fetchSnapshot(addr, previous);
    expect(snapshot.days).toEqual(FEED_DAYS);
    expect(snapshot.houseCheckedAt).toBe(previous.houseCheckedAt);
    expect(log.warn).toHaveBeenCalledWith('dtek-krem: the page failed (emergency), using mirror kyiv', expect.any(ProviderError));
    expect(log.error).not.toHaveBeenCalled();
  }
  { // the house check already failed in this run: the page is not tried twice
    const s = fakeSession();
    s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
    const y = yasno(), m = mirror();
    const { p } = provider(s, [y, m]);
    expect((await p.fetchSnapshot(addr, null)).days).toEqual(FEED_DAYS);
    expect(s.ensureReady).toHaveBeenCalledTimes(1);
  }
  { // the page is not allowed: the second feed's answer
    const y = yasno(), m = mirror();
    const { p, s } = provider(fakeSession(), [y, m]);
    await pageClosedRecently(p);
    expect((await p.fetchSnapshot(addr, fresh())).days).toEqual(FEED_DAYS);
    expect(s.opens).toBe(1);
    expect(homeNums(s)).toBe(0);
  }
});

test('no usable feed, the page not tried and allowed → the page; its CaptchaRequiredError propagates', async () => {
  {
    const { p, s, log } = provider(fakeSession(), [feed('mirror kyiv-region', unusable('stale'))]);
    expect((await p.fetchSnapshot(addr, fresh())).houseCheckedAt).toBe(nowIso());
    expect(homeNums(s)).toBe(1);
    expect(log.info).toHaveBeenCalledWith('dtek-krem: using the page', { reason: 'fallback' });
  }
  const s = fakeSession();
  s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  const { p } = provider(s, [feed('mirror kyiv-region', unusable('stale'))]);
  await expect(p.fetchSnapshot(addr, fresh())).rejects.toBeInstanceOf(CaptchaRequiredError);
  expect(s.ensureReady).toHaveBeenCalledTimes(1);
});

test('the house check failed with a verification and no feed is usable → CaptchaRequiredError', async () => {
  const s = fakeSession();
  s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  const { p, log } = provider(s, [feed('mirror kyiv-region', new ProviderError('Не вдалося прочитати'))]);
  await expect(p.fetchSnapshot(addr, null)).rejects.toBeInstanceOf(CaptchaRequiredError);
  expect(s.ensureReady).toHaveBeenCalledTimes(1);
  // Logged once, as today's failed refresh.
  expect(log.warn).toHaveBeenCalledWith('dtek-krem fetchSnapshot: verification required', expect.any(CaptchaRequiredError));
  expect(log.error).not.toHaveBeenCalled();
});

/** A previous older than the page budget, with a fresh house check: only the feeds could have renewed it. */
const oldPrevious = (age = 31 * MIN) => snap({ fetchedAt: ago(age), houseCheckedAt: ago(HOUR) });
const KEEPING = 'dtek-krem: no usable feed, the page is not due yet; keeping the last schedule';

test('no usable feed, the page closed and opened 10 min ago, previous 31 min old → FEEDS_FAILED_TEXT', async () => {
  {
    const { p, s, log } = provider(fakeSession(), [feed('yasno', unusable('stale')), feed('mirror kyiv', new ProviderError('x'))]);
    await pageClosedRecently(p);
    expect(s.release).toHaveBeenCalledTimes(1);
    const err = await p.fetchSnapshot(addr, oldPrevious()).catch(e => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err.message).toBe(FEEDS_FAILED_TEXT);
    expect(s.opens).toBe(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalledWith(KEEPING);
    // Exactly the budget's age is not younger than it.
    expect((await p.fetchSnapshot(addr, oldPrevious(30 * MIN)).catch(e => e)).message).toBe(FEEDS_FAILED_TEXT);
  }
  { // every feed rejected for lack of a connection
    const offline = () => new NetworkError('Немає з’єднання');
    const { p, s } = provider(fakeSession(), [feed('yasno', offline()), feed('mirror kyiv', offline())]);
    await pageClosedRecently(p);
    const err = await p.fetchSnapshot(addr, oldPrevious()).catch(e => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toBe(FEEDS_FAILED_TEXT);
    expect(s.opens).toBe(1);
  }
});
test('no usable feed, only the budget refuses the page, previous fetched by the page 10 min ago → previous, kept as it is', async () => {
  const { p, s, log } = provider(fakeSession(), [feed('yasno', unusable('stale')), feed('mirror kyiv', new ProviderError('x'))]);
  await pageClosedRecently(p);
  const previous = snap({ fetchedAt: ago(10 * MIN), houseCheckedAt: ago(10 * MIN) });
  const before = structuredClone(previous);
  const result = await p.fetchSnapshot(addr, previous);
  expect(result).toStrictEqual(before);
  expect(result.fetchedAt).toBe(before.fetchedAt);
  expect(s.opens).toBe(1);
  expect(homeNums(s)).toBe(0);
  expect(log.warn).toHaveBeenCalledWith(KEEPING);
  expect(log.error).not.toHaveBeenCalled();
});
test('every feed offline, previous fresh, the page not allowed → previous (a fresh snapshot shows no network banner)', async () => {
  const offline = () => new NetworkError('Немає з’єднання');
  const { p, s, log } = provider(fakeSession(), [feed('yasno', offline()), feed('mirror kyiv', offline())]);
  await pageClosedRecently(p);
  const previous = fresh(); // fetched 15 min ago
  const before = structuredClone(previous);
  expect(await p.fetchSnapshot(addr, previous)).toStrictEqual(before);
  expect(s.opens).toBe(1);
  expect(log.warn).toHaveBeenCalledWith(KEEPING);
  expect(log.error).not.toHaveBeenCalled();
});
test('the page tried and failed is still the error, even with a fresh previous', async () => {
  const s = fakeSession();
  s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  const { p, log } = provider(s, [feed('mirror kyiv-region', unusable('stale'))]);
  await expect(p.fetchSnapshot(addr, snap({ fetchedAt: ago(5 * MIN), houseCheckedAt: ago(25 * HOUR) })))
    .rejects.toBeInstanceOf(CaptchaRequiredError);
  expect(log.warn).not.toHaveBeenCalledWith(KEEPING);
});

describe('the house check finds the house missing (DTEK renamed or removed it)', () => {
  const gone: Address = { ...addr, house: '999' };
  const HOUSE_MISSING = 'Будинок не знайдено у відповіді ДТЕК';
  test('houseCheckedAt 49 h ago, a feed answers → the house-missing error', async () => {
    const { p, feeds, log } = provider();
    const err = await p.fetchSnapshot(gone, snap({ address: gone, houseCheckedAt: ago(49 * HOUR) })).catch(e => e);
    expect(err).toBeInstanceOf(AddressNotFoundError);
    expect(err.message).toBe(HOUSE_MISSING);
    expect(feeds[0].read).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('dtek-krem fetchSnapshot failed', err);
  });
  test('no houseCheckedAt on record (no previous) → the house-missing error', async () => {
    const { p, feeds } = provider();
    await expect(p.fetchSnapshot(gone, null)).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(feeds[0].read).not.toHaveBeenCalled();
  });
  test.each([
    ['25 h ago', 25 * HOUR],
    ['exactly 48 h ago (not older)', 48 * HOUR],
    ['1 h in the future (a clock set back: neither missing nor older)', -HOUR],
  ])('houseCheckedAt %s → the feed\'s answer and a warn', async (_name, age) => {
    const { p, feeds, log } = provider();
    const previous = snap({ address: gone, houseCheckedAt: ago(age) });
    const snapshot = await p.fetchSnapshot(gone, previous);
    expect(feeds[0].read).toHaveBeenCalledTimes(1);
    expect(snapshot.days).toEqual(FEED_DAYS);
    expect(snapshot.houseCheckedAt).toBe(previous.houseCheckedAt);
    expect(log.warn).toHaveBeenCalledWith(
      'dtek-krem: the page failed (house check), using mirror kyiv-region', expect.any(AddressNotFoundError),
    );
    expect(log.error).not.toHaveBeenCalled();
  });
  test('an unreadable houseCheckedAt counts as missing → the house-missing error', async () => {
    const { p } = provider();
    await expect(p.fetchSnapshot(gone, snap({ address: gone, houseCheckedAt: 'not a date' })))
      .rejects.toBeInstanceOf(AddressNotFoundError);
  });
});

test('no previous and the page not allowed → the feed\'s answer with the synthesized line, no houseCheckedAt', async () => {
  const { p, s, feeds } = provider(fakeSession(), [feed('mirror kyiv-region', answer({ groupLabel: 'Черга 1.2 (ДТЕК)' }))]);
  await pageClosedRecently(p);
  const snapshot = await p.fetchSnapshot(addr, null);
  expect(snapshot).toStrictEqual({
    providerId: 'dtek-krem', address: addr, groupId: 'GPV1.2', groupLabel: 'Черга 1.2 (ДТЕК)',
    days: FEED_DAYS, sourceUpdatedAt: '21.10.2026 19:20', fetchedAt: nowIso(),
    lines: [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2 (ДТЕК)' }],
  });
  // No name from the feed and no previous: the label from the id.
  feeds[0].read.mockResolvedValueOnce(answer());
  const bare = await p.fetchSnapshot(addr, null);
  expect(bare.groupLabel).toBe('Черга 1.2');
  expect(bare.lines).toEqual([{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }]);
  expect(s.opens).toBe(1);
});

test('carried lines keep a line change', async () => {
  // DTEK moved the house: its lines (GPV1.2, GPV4.2) lack the saved GPV3.1.
  const moved: Address = { ...addr, groupId: 'GPV3.1' };
  const { p, feeds } = provider();
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  const { id } = store.addLocation({ name: 'Дім', address: moved, widgetStyle: 'compact', widgetPosition: null });
  const svc = new RefreshService({ store, getProvider: () => p });
  expect(await svc.refresh(id)).toBe('ok');
  const fromPage = svc.getStates()[0];
  expect(fromPage.snapshot!.houseCheckedAt).toBe(nowIso());
  expect(fromPage.lineChanged).toBe(true);
  await vi.advanceTimersByTimeAsync(15 * MIN);
  expect(await svc.refresh(id)).toBe('ok');
  const fromFeed = svc.getStates()[0];
  expect(feeds[0].read).toHaveBeenCalledTimes(1);
  expect(fromFeed.snapshot!.fetchedAt).toBe(nowIso());
  expect(fromFeed.snapshot!.lines).toEqual(fromPage.snapshot!.lines);
  expect(fromFeed.snapshot!.houseCheckedAt).toBe(fromPage.snapshot!.houseCheckedAt);
  expect(fromFeed.lineChanged).toBe(true);
});

test('two locations, one open', async () => {
  const { p, s, feeds } = provider();
  const home = await p.fetchSnapshot(addr, null);
  await vi.advanceTimersByTimeAsync(30_000);
  const other = await p.fetchSnapshot({ ...addr, house: '13' }, null);
  expect(s.opens).toBe(1);
  expect(readFacts(s)).toBe(1);
  expect(homeNums(s)).toBe(2);
  expect(home.houseCheckedAt).toBeDefined();
  expect(other.houseCheckedAt).toBe(nowIso());
  expect(feeds[0].read).not.toHaveBeenCalled();
});

test('linger', async () => {
  const { p, s } = provider();
  await p.listStreets(C);
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS - 1);
  expect(s.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.release).toHaveBeenCalledTimes(1);
  // After a release the next use reads the fact again.
  await p.listStreets(C);
  expect(readFacts(s)).toBe(2);
  // A use 4 min in moves the release to 5 min after it.
  await vi.advanceTimersByTimeAsync(4 * MIN);
  await p.listStreets(C);
  expect(readFacts(s)).toBe(2);
  await vi.advanceTimersByTimeAsync(MIN);
  expect(s.release).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4 * MIN);
  expect(s.release).toHaveBeenCalledTimes(2);
  // dispose() drops a pending linger.
  await p.listStreets(C);
  p.dispose();
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).toHaveBeenCalledTimes(2);
});

test('a refresh\'s page lingers 1 min; it never shortens a wizard step\'s 5 min', async () => {
  const { p, s } = provider();
  await p.fetchSnapshot(addr, null); // a house check
  await vi.advanceTimersByTimeAsync(PAGE_REFRESH_LINGER_MS - 1);
  expect(s.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.release).toHaveBeenCalledTimes(1);
  // The wizard's line preview right after its house list: the list's 5 min still holds.
  await p.listStreets(C);
  await vi.advanceTimersByTimeAsync(MIN);
  await p.fetchSnapshot({ ...addr, house: '13' }, null);
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS - MIN - 1);
  expect(s.release).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.release).toHaveBeenCalledTimes(2);
});

test('showVerification arms the linger', async () => {
  const { p, s } = provider();
  let shown!: () => void;
  s.showForUser.mockImplementation(() => new Promise<void>(r => { shown = r; }));
  const verification = p.showVerification();
  // A page use that ends while the verification still shows arms nothing.
  await p.listStreets(C);
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).not.toHaveBeenCalled();
  shown();
  await verification;
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS - 1);
  expect(s.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.release).toHaveBeenCalledTimes(1);
});

test('no feeds: the page stays and every refresh uses it', async () => {
  const { p, s } = provider(fakeSession(), []);
  await p.fetchSnapshot(addr, null);
  await vi.advanceTimersByTimeAsync(15 * MIN);
  expect(s.release).not.toHaveBeenCalled();
  const again = await p.fetchSnapshot(addr, fresh());
  expect(homeNums(s)).toBe(2);
  expect(again.houseCheckedAt).toBe(nowIso());
  // A failed load neither releases the page nor holds the next refresh to a budget.
  failedLoad(s, new CaptchaRequiredError('x'));
  await expect(p.fetchSnapshot(addr, fresh())).rejects.toBeInstanceOf(CaptchaRequiredError);
  await vi.advanceTimersByTimeAsync(MIN);
  expect((await p.fetchSnapshot(addr, fresh())).houseCheckedAt).toBe(nowIso());
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).not.toHaveBeenCalled();
});
test('no feeds: a first load that fails is retried on the next refresh, not refused by the budget', async () => {
  const s = fakeSession();
  failedLoad(s, new ProviderError('Сайт ДТЕК не відповідає'));
  const { p } = provider(s, []);
  await expect(p.fetchSnapshot(addr, null)).rejects.toThrow('Сайт ДТЕК не відповідає');
  s.open = false; // the window is gone (closed by DTEK or the OS), and the last open was 1 min ago
  await vi.advanceTimersByTimeAsync(MIN);
  expect((await p.fetchSnapshot(addr, null)).houseCheckedAt).toBe(nowIso());
  expect(s.ensureReady).toHaveBeenCalledTimes(2);
});

test('a failed page use releases at once, so the next open goes through the budget', async () => {
  const { p, s, feeds } = provider();
  failedLoad(s, new CaptchaRequiredError('x'));
  // Location A: its house check hits a verification, and the feed answers.
  const a = await p.fetchSnapshot(addr, snap({ houseCheckedAt: ago(25 * HOUR) }));
  expect(a.days).toEqual(FEED_DAYS);
  expect(s.release).toHaveBeenCalledTimes(1);
  expect(s.open).toBe(false);
  // Location B, 1 min later and with no previous: the budget refuses the page, the feed answers.
  await vi.advanceTimersByTimeAsync(MIN);
  const b = await p.fetchSnapshot({ ...addr, house: '13' }, null);
  expect(s.ensureReady).toHaveBeenCalledTimes(1);
  expect(feeds[0].read).toHaveBeenCalledTimes(2);
  expect(b.lines).toEqual([{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }]);
  expect('houseCheckedAt' in b).toBe(false);
  // No linger follows a failure.
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).toHaveBeenCalledTimes(1);
});
test('a failed page use forgets the cached fact, as the linger does', async () => {
  const { p, s } = provider();
  await p.listStreets(C);
  expect(readFacts(s)).toBe(1);
  s.evaluate.mockRejectedValueOnce(new TypeError('boom')); // the house check's getHomeNum
  await vi.advanceTimersByTimeAsync(MIN);
  expect((await p.fetchSnapshot(addr, null)).days).toEqual(FEED_DAYS);
  expect(s.release).toHaveBeenCalledTimes(1);
  await p.listStreets(C);
  expect(readFacts(s)).toBe(2);
});
test('a failed page use while the verification shows releases nothing', async () => {
  const { p, s } = provider();
  let shown!: () => void;
  s.showForUser.mockImplementation(() => new Promise<void>(r => { shown = r; }));
  const verification = p.showVerification();
  failedLoad(s, new CaptchaRequiredError('x'));
  await expect(p.listStreets(C)).rejects.toBeInstanceOf(CaptchaRequiredError);
  expect(s.release).not.toHaveBeenCalled();
  shown();
  await verification;
  await vi.advanceTimersByTimeAsync(PAGE_LINGER_MS);
  expect(s.release).toHaveBeenCalledTimes(1);
});
