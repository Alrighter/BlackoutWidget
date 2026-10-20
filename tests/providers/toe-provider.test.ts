import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOE_QUIET_NOTE, ToeProvider } from '../../src/main/providers/toe';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const fx = (n: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'toe', n), 'utf8');
const CITIES = fx('pw_cities_all.json');
const STREETS_1032 = fx('pw_streets_city1032.json');
const BN_47931 = fx('building-names_city1032_street47931.json');
const BN_31848 = fx('building-names_city1032_street31848_mixed-groups.json');
const BG_1_2 = fx('building-groups_1032_47931_1-A.json');
const GPV_1_2 = fx('a_gpv_g_2026-10-17_house-1032-47931-1_group1.2.json');
const GPV_TWO = fx('a_gpv_g_2026-10-17_house-1032-31848-29_groups2.2+4.1.json');
const GPV_QUIET = fx('a_gpv_g_quiet-2026-10-20_valid-key.json');
const ACC_383 = fx('pw_accidents_city383_street3752_2026-10-20.json');
const PLANNED_22085 = fx('pw_accident_planeds_city22085_street41475_2026-10-20.json');

const API = 'https://api-poweron.toe.com.ua/api';
const NAME = 'Тернопільобленерго';
const UNREADABLE = `Не вдалося прочитати графік ${NAME}`;
const NO_ANSWER = `Сайт ${NAME} не відповідає`;
const HTTP_ERROR = `Сайт ${NAME} повернув помилку`;
const NOT_FOUND = `Адресу не знайдено у ${NAME} — оберіть її в налаштуваннях заново`;
const EMPTY = JSON.stringify({ '@type': 'hydra:Collection', 'hydra:member': [], 'hydra:totalItems': 0 });

type Init = Parameters<HttpFetch>[1];
type Route = (q: URLSearchParams, init: Init) => HttpResponse | Error;

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});
const hydra = (members: unknown[]) => JSON.stringify({ '@type': 'hydra:Collection', 'hydra:member': members, 'hydra:totalItems': members.length });
const groups = (...queues: string[]) => JSON.stringify({ buildingGroups: queues.map((chergGpv) => ({ chergGpv })) });
const names = (rows: [string, string][]) => JSON.stringify({ buildingNames: rows.map(([buildingName, chergGpv]) => ({ id: 1, buildingName, chergGpv })) });

// Збараж and Нагірянка: only their outage rows were saved; the street and house answers are made up in the API's shape.
const STREETS: Record<string, string> = {
  1032: STREETS_1032,
  383: hydra([{ id: 3752, name: 'вул. Івана Франка' }]),
  22085: hydra([{ id: 41475, name: 'вул. Світлична' }]),
};
const BUILDING_NAMES: Record<string, string> = {
  '1032/47931': BN_47931,
  '1032/31848': BN_31848,
  '383/3752': names([['10', '1.2']]),
  '22085/41475': names([['1', '2.1']]),
};

const decodeKey = (init: Init) => Buffer.from(init.headers?.['X-debug-key'] ?? '', 'base64').toString('utf8');

/** The house's queues as `building-groups` gives them: from `building-names`, except house 29 on Об’їзна (two queues, live answer). */
function buildingGroups(q: URLSearchParams): string {
  const street = `${q.get('cityId')}/${q.get('streetId')}`;
  const house = q.get('buildingNames');
  if (street === '1032/47931' && house === '1-А') return BG_1_2;
  if (street === '1032/31848' && house === '29') return groups('2.2', '4.1');
  const rows = BUILDING_NAMES[street] ? JSON.parse(BUILDING_NAMES[street]).buildingNames : [];
  const row = rows.find((r: { buildingName: string }) => r.buildingName === house);
  return groups(...(row && /^\d\.\d$/.test(row.chergGpv) ? [row.chergGpv] : []));
}

/** Like the live API: the 17.10 record answers when the window (dates, inclusive) covers 17.10, for the keys it was saved for. */
function gpv(q: URLSearchParams, init: Init): HttpResponse {
  const after = q.get('after')!.slice(0, 10);
  const before = q.get('before')!.slice(0, 10);
  if (!(after <= '2026-10-17' && '2026-10-17' <= before)) return ok(GPV_QUIET);
  const key = decodeKey(init);
  if (key.startsWith('1032/47931/')) return ok(GPV_1_2);
  if (key === '1032/31848/29') return ok(GPV_TWO);
  return ok(GPV_QUIET);
}

/** Routes by path and id parameters to the saved answers. An unknown request rejects, so a wrong pick fails the test. */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const street = (q: URLSearchParams) => `${q.get('city.id')}/${q.get('street.id')}`;
  const routes: Record<string, Route> = {
    '/api/pw_cities': () => ok(CITIES),
    '/api/pw_streets': (q) => (STREETS[q.get('city.id')!] ? ok(STREETS[q.get('city.id')!]) : new Error('no such city')),
    '/api/pw-accounts/building-names': (q) => ok(BUILDING_NAMES[`${q.get('cityId')}/${q.get('streetId')}`] ?? names([])),
    '/api/pw-accounts/building-groups': (q) => ok(buildingGroups(q)),
    '/api/a_gpv_g': gpv,
    '/api/pw_accidents': (q) => ok(street(q) === '383/3752' ? ACC_383 : EMPTY),
    '/api/pw_accident_planeds': (q) => ok(street(q) === '22085/41475' ? PLANNED_22085 : EMPTY),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const route = u.origin === 'https://api-poweron.toe.com.ua' ? routes[u.pathname] : undefined;
    if (!route) throw new Error(`unexpected request ${url}`);
    const r = route(u.searchParams, init);
    if (r instanceof Error) throw r;
    return r;
  });
  const to = (path: string) => calls.filter((c) => new URL(c.url).pathname === `/api/${path}`);
  return { fetch, calls, to };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: () => Date } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const now = opts.now ?? (() => at('2026-10-17', 12));
  const p = new ToeProvider({ fetch: http.fetch, isOnline: () => true, log, now });
  return { p, http, log };
}

async function expectError(p: Promise<unknown>, cls: typeof ProviderError, message: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
  return err as Error;
}

const YURCHAKA: Address = {
  providerId: 'toe', city: 'Тернопіль', street: 'вул. Василя Юрчака', house: '1', lineIndex: 1, groupId: '1.2',
};
const OBIZNA = 'вул. Об’їзна';
const ZBARAZH: Address = {
  providerId: 'toe', city: 'Збараж', street: 'вул. Івана Франка', house: '10', lineIndex: 1, groupId: '1.2',
};
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
/** 17.10, queue 1.2: maybe 10:30, off 11:00-14:00, maybe 14:00. */
const OCT17_1_2: Slot[] = Array.from({ length: 48 }, (_, i): Slot => {
  if (i === 21 || i === 28) return 'maybe-off';
  return i > 21 && i < 28 ? 'off' : 'on';
});

describe('ToeProvider address lookup', () => {
  it('listCities drops empty names and labels both «Ланівці» with their громада', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toHaveLength(55);
    expect(cities).not.toContain('');
    expect(cities).toContain('Ланівці (Лановецька громада)');
    expect(cities).toContain('Ланівці (Борщівська громада)');
    expect(cities).not.toContain('Ланівці');
    expect(cities).toContain('Тернопіль');
    // Two «Київ» in one громада: the second is numbered.
    expect(cities).toContain('Київ (Лосинівська громада)');
    expect(cities).toContain('Київ (Лосинівська громада) (2)');
    expect(cities).toEqual([...cities].sort((a, b) => a.localeCompare(b, 'uk')));
    expect(http.calls.map((c) => c.url)).toEqual([`${API}/pw_cities?pagination=false&otg.id=`]);
  });

  it('keeps the city list for the run', async () => {
    const { p, http } = setup();
    await p.listCities();
    await p.listCities();
    await p.listStreets('Тернопіль');
    expect(http.to('pw_cities')).toHaveLength(1);
  });

  it('listStreets resolves the city to its id and sorts the names', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets('Тернопіль');
    expect(streets).toHaveLength(299);
    expect(streets).toContain('вул. Василя Юрчака');
    expect(streets).toEqual([...streets].sort((a, b) => a.localeCompare(b, 'uk')));
    expect(http.to('pw_streets').map((c) => c.url)).toEqual([`${API}/pw_streets?pagination=false&city.id=1032`]);
  });

  it('listStreets numbers a repeated street name', async () => {
    const http = fakeHttp({ '/api/pw_streets': () => ok(hydra([{ id: 1, name: 'вул. Шевченка' }, { id: 2, name: ' вул. Шевченка ' }])) });
    const { p } = setup({ http });
    expect(await p.listStreets('Тернопіль')).toEqual(['вул. Шевченка', 'вул. Шевченка (2)']);
  });

  it('an ambiguous bare city label is not found', async () => {
    const { p } = setup();
    await expectError(p.listStreets('Ланівці'), AddressNotFoundError, NOT_FOUND);
  });

  it('listHouses gives the building-names queue with linesPending', async () => {
    const { p, http } = setup();
    const houses = await p.listHouses('Тернопіль', 'вул. Василя Юрчака');
    expect(houses).toHaveLength(28);
    expect(houses[0]).toEqual({
      house: '1', lines: [{ index: 1, groupId: '1.2', label: 'Черга 1.2' }], outageActive: false, linesPending: true,
    });
    expect(houses.map((h) => h.house)).toContain('1-А');
    expect(http.to('pw-accounts/building-names').map((c) => c.url))
      .toEqual([`${API}/pw-accounts/building-names?cityId=1032&streetId=47931`]);
  });

  it('listHouses gives «Не входить» houses the always-on line', async () => {
    const { p } = setup();
    const houses = await p.listHouses('Тернопіль', OBIZNA);
    expect(houses.find((h) => h.house === '3')?.lines).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
    expect(houses.find((h) => h.house === 'дорога')?.lines).toEqual([{ index: 1, groupId: '4.1', label: 'Черга 4.1' }]);
  });

  it('listHouses skips rows with an empty house and keeps the house text byte for byte', async () => {
    const http = fakeHttp({ '/api/pw-accounts/building-names': () => ok(names([['', '1.1'], ['12-А', '1.1'], [' ', '1.1']])) });
    const { p } = setup({ http });
    expect((await p.listHouses('Тернопіль', 'вул. Василя Юрчака')).map((h) => h.house)).toEqual(['12-А']);
  });

  it('houseLines for house «29» gives both of its queues', async () => {
    const { p, http } = setup();
    expect(await p.houseLines('Тернопіль', OBIZNA, '29')).toEqual([
      { index: 1, groupId: '2.2', label: 'Черга 2.2' },
      { index: 2, groupId: '4.1', label: 'Черга 4.1' },
    ]);
    expect(http.to('pw-accounts/building-groups').map((c) => c.url))
      .toEqual([`${API}/pw-accounts/building-groups?cityId=1032&streetId=31848&buildingNames=29`]);
  });

  it('houseLines encodes the house text as it is', async () => {
    const { p, http } = setup();
    expect(await p.houseLines('Тернопіль', 'вул. Василя Юрчака', '1-А')).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect(http.to('pw-accounts/building-groups')[0].url).toBe(
      `${API}/pw-accounts/building-groups?cityId=1032&streetId=47931&buildingNames=${encodeURIComponent('1-А')}`,
    );
  });

  it('houseLines: no queues gives the always-on line for a listed house, nothing for an unknown one', async () => {
    const { p } = setup();
    expect(await p.houseLines('Тернопіль', OBIZNA, '3')).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
    expect(await p.houseLines('Тернопіль', OBIZNA, '999')).toEqual([]);
  });
});

describe('ToeProvider.fetchSnapshot', () => {
  it('reads the 17.10 schedule of queue 1.2 for Юрчака 1', async () => {
    const { p } = setup();
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: OCT17_1_2 }]);
    expect(snap.sourceUpdatedAt).toBe('18:52 17.10.2026');
    expect(snap).toMatchObject({
      providerId: 'toe', address: YURCHAKA, groupId: '1.2', groupLabel: 'Черга 1.2', fetchedAt: at('2026-10-17', 12).toISOString(),
    });
    expect(snap.lines).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect('note' in snap).toBe(false);
    expect('currentOutage' in snap).toBe(false);
  });

  it('reads the saved queue of a house on two queues', async () => {
    const { p } = setup();
    const snap = await p.fetchSnapshot({ ...YURCHAKA, street: OBIZNA, house: '29', lineIndex: 2, groupId: '4.1' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: OCT17_1_2 }]);
    expect(snap.lines.map((l) => l.groupId)).toEqual(['2.2', '4.1']);
  });

  it('asks a_gpv_g with the site\'s window, the address key and only the Accept header', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(YURCHAKA);
    const [call] = http.to('a_gpv_g');
    expect(call.url).toMatch(
      /^https:\/\/api-poweron\.toe\.com\.ua\/api\/a_gpv_g\?before=2026-10-18T00:00:00%2B00:00&after=2026-10-16T12:00:00%2B00:00&time=[0-9a-z]+$/,
    );
    expect(decodeKey(call.init)).toBe('1032/47931/1');
    expect(Object.keys(call.init.headers ?? {}).sort()).toEqual(['Accept', 'X-debug-key']);
  });

  it('sends Accept: application/ld+json and never an Origin header, each request with a timeout', async () => {
    const { p, http } = setup({ now: () => at('2026-10-20', 10) });
    await p.listCities();
    await p.listHouses('Тернопіль', OBIZNA);
    await p.houseLines('Тернопіль', OBIZNA, '29');
    await p.fetchSnapshot(ZBARAZH);
    expect(http.calls.length).toBeGreaterThan(6);
    for (const c of http.calls) {
      expect(c.init.method).toBe('GET');
      expect(c.init.headers?.Accept).toBe('application/ld+json');
      expect(Object.keys(c.init.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('origin');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sends a different time on every call, so the edge cache never answers for another address (Review Focus 5)', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(YURCHAKA);
    await p.fetchSnapshot(YURCHAKA);
    const times = http.to('a_gpv_g').map((c) => new URL(c.url).searchParams.get('time'));
    expect(times).toHaveLength(2);
    expect(times[0]).toBeTruthy();
    expect(times[0]).not.toBe(times[1]);
  });

  it('a day with nothing published is all on with the quiet note', async () => {
    const { p } = setup({ now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.note).toBe(TOE_QUIET_NOTE);
    expect(snap.note).toBe('Тернопільобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає');
    expect('sourceUpdatedAt' in snap).toBe(false);
  });

  it('an empty member list after a passed check is the quiet day too', async () => {
    const http = fakeHttp({ '/api/a_gpv_g': () => ok(EMPTY) });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('on') }]);
    expect(snap.note).toBe(TOE_QUIET_NOTE);
  });

  it('adds tomorrow once its member is there; today without one is the quiet day', async () => {
    const { p } = setup({ now: () => at('2026-10-16', 21) });
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-16', slots: fill('on') }, { date: '2026-10-17', slots: OCT17_1_2 }]);
    expect(snap.note).toBe(TOE_QUIET_NOTE);
    expect('sourceUpdatedAt' in snap).toBe(false);
  });

  it('yesterday\'s member is not today', async () => {
    const { p } = setup({ now: () => at('2026-10-18', 9) });
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-18', slots: fill('on') }]);
    expect(snap.note).toBe(TOE_QUIET_NOTE);
  });

  it('a moved queue gives today unknown and the new lines, not an error', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...YURCHAKA, groupId: '5.1' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('unknown') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect(snap.groupLabel).toBe('Черга 5.1');
    expect('note' in snap).toBe(false);
    expect(http.to('a_gpv_g')).toHaveLength(0);
  });

  it('a house out of the schedule saved as none is all on without reading the schedule', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...YURCHAKA, street: OBIZNA, house: '3', groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('on') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
    expect(snap.groupLabel).toBe('Не входить до ГПВ');
    expect('note' in snap).toBe(false);
    expect(http.to('a_gpv_g')).toHaveLength(0);
  });

  it('a house saved as none that joined a queue is a moved line', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...YURCHAKA, groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('unknown') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect(http.to('a_gpv_g')).toHaveLength(0);
  });

  it('a house gone from building-names is not found', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...YURCHAKA, house: '999' }), AddressNotFoundError, NOT_FOUND);
    expect(http.to('a_gpv_g')).toHaveLength(0);
  });

  it('a street gone from the list is not found', async () => {
    const { p } = setup();
    await expectError(p.fetchSnapshot({ ...YURCHAKA, street: 'вул. Неіснуюча' }), AddressNotFoundError, NOT_FOUND);
  });

  it('the house check failing is an error, never the saved line', async () => {
    const rejected = setup({ http: fakeHttp({ '/api/pw-accounts/building-groups': () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(YURCHAKA), ProviderError, NO_ANSWER);
    const odd = setup({ http: fakeHttp({ '/api/pw-accounts/building-groups': () => ok('{"groups":[]}') }) });
    await expectError(odd.p.fetchSnapshot(YURCHAKA), ProviderError, UNREADABLE);
    expect(odd.http.to('a_gpv_g')).toHaveLength(0);
  });

  it('the check passes and then a_gpv_g fails: an error, never a quiet day (Review Focus 4)', async () => {
    const rejected = setup({ http: fakeHttp({ '/api/a_gpv_g': () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(YURCHAKA), ProviderError, NO_ANSWER);
    const forbidden = setup({ http: fakeHttp({ '/api/a_gpv_g': () => failStatus(403) }) });
    await expectError(forbidden.p.fetchSnapshot(YURCHAKA), ProviderError, HTTP_ERROR);
    const html = setup({ http: fakeHttp({ '/api/a_gpv_g': () => ok('<html>Just a moment…</html>') }) });
    await expectError(html.p.fetchSnapshot(YURCHAKA), ProviderError, UNREADABLE);
    const shape = setup({ http: fakeHttp({ '/api/a_gpv_g': () => ok('{"hydra:member":{}}') }) });
    await expectError(shape.p.fetchSnapshot(YURCHAKA), ProviderError, UNREADABLE);
  });

  it('today\'s member without the saved queue is unreadable', async () => {
    const http = fakeHttp({ '/api/a_gpv_g': () => ok(GPV_TWO) });
    const { p } = setup({ http });
    await expectError(p.fetchSnapshot(YURCHAKA), ProviderError, UNREADABLE);
  });
});

describe('ToeProvider current outage', () => {
  it('the Збараж emergency is over at 14:00 and running at 10:00', async () => {
    const late = setup({ now: () => at('2026-10-20', 14) });
    const after = await late.p.fetchSnapshot(ZBARAZH);
    expect('currentOutage' in after).toBe(false);
    expect(after.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);

    const { p, http } = setup({ now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot(ZBARAZH);
    expect(snap.currentOutage).toEqual({
      kind: 'emergency', text: 'Аварійне відключення', start: '03:31 20.10.2026', end: '13:00 20.10.2026',
    });
    expect(http.to('pw_accidents').map((c) => c.url)).toEqual([`${API}/pw_accidents?page=1&city.id=383&street.id=3752`]);
    expect(http.to('pw_accident_planeds').map((c) => c.url))
      .toEqual([`${API}/pw_accident_planeds?page=1&city.id=383&street.id=3752`]);
  });

  it('planned works running now are a planned outage', async () => {
    const { p } = setup({ now: () => at('2026-10-21', 9) });
    const snap = await p.fetchSnapshot({ ...ZBARAZH, city: 'Нагірянка', street: 'вул. Світлична', house: '1', groupId: '2.1' });
    expect(snap.currentOutage).toEqual({
      kind: 'planned', text: 'Планові роботи', start: '08:00 21.10.2026', end: '17:00 21.10.2026',
    });
  });

  it('the outage applies to a house out of the schedule too', async () => {
    const http = fakeHttp({
      '/api/pw-accounts/building-names': () => ok(names([['10', 'Не входить']])),
      '/api/pw-accounts/building-groups': () => ok(groups()),
    });
    const { p } = setup({ http, now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot({ ...ZBARAZH, groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.currentOutage?.kind).toBe('emergency');
  });

  it('a rejected pw_accidents still delivers the schedule', async () => {
    const http = fakeHttp({ '/api/pw_accidents': () => new Error('ECONNRESET') });
    const { p, log } = setup({ http });
    const snap = await p.fetchSnapshot(YURCHAKA);
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: OCT17_1_2 }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^toe /), expect.anything());
  });

  it('an outage answer of another shape still delivers the schedule', async () => {
    const http = fakeHttp({ '/api/pw_accident_planeds': () => ok('{"hydra:member":null}') });
    const { p, log } = setup({ http, now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot(ZBARAZH);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('never carries koment', async () => {
    const { p, log } = setup({ now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot(ZBARAZH);
    expect(snap.currentOutage?.kind).toBe('emergency');
    expect(JSON.stringify(snap)).not.toContain('Пошкодження');
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('Пошкодження');
  });
});
