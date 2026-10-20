import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOE_QUIET_NOTE, LoeProvider } from '../../src/main/providers/loe';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const raw = (n: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'loe', n), 'utf8');
const MENUS = raw('menus-photo-grafic-2026-10-20-trimmed.json');
const TODAY_ITEM = raw('menu_item-238-today-2026-10-20.json');
const TOMORROW_ITEM = raw('menu_item-256-tomorrow-2026-10-20.json');
const CITIES = raw('pw_cities-sample.json');
const STREETS_693 = raw('pw_streets-city693-lviv-first80-2026-10-20.json');
const ACC_95 = raw('pw_accounts-city693-street12448-building95-2026-10-20.json');
const ACC_1174 = raw('pw_accounts-city1174-street13439-2026-10-20.json');
const ACCIDENTS = raw('pw_accidents-page1-2026-10-20-koment-redacted.json');

const CMS = 'https://api.loe.lviv.ua/api';
const API = 'https://power-api.loe.lviv.ua/api';
const NAME = 'Львівобленерго';
const UNREADABLE = `Не вдалося прочитати графік ${NAME}`;
const NO_ANSWER = `Сайт ${NAME} не відповідає`;
const NOT_FOUND = `Адресу не знайдено у ${NAME} — оберіть її в налаштуваннях заново`;

type Init = Parameters<HttpFetch>[1];
type Route = (q: URLSearchParams, init: Init) => HttpResponse | Error;

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});
const hydra = (members: unknown[]) => JSON.stringify({ '@type': 'hydra:Collection', 'hydra:member': members, 'hydra:totalItems': members.length });
const membersOf = (body: string): any[] => JSON.parse(body)['hydra:member'];

/** Account rows in the API's shape: only the house and its ГПВ queue vary. */
const accountRows = (cityId: number, rows: [string, string][]) => rows.map(([buildingName, chergGpv], i) => ({
  '@id': `/api/pw_accounts/${i + 1}`, '@type': 'PwAccount', id: i + 1, city: `/api/pw_cities/${cityId}`, buildingName, chergGpv,
  chergGav: 'Не входить', chergAchr: 'Не входить', chergGvsp: 'Не входить', chergSgav: 'Не входить',
  disconnectionTask: false, planedReplaceCounter: false,
}));

// Брюховичі, Старий Яр, Буковинка and Червоноград: only their accounts or outage rows were saved (or nothing at all);
// their street lists are made up in the API's shape with the ids the saved rows use.
const STREETS: Record<string, string> = {
  693: STREETS_693,
  1174: hydra([{ id: 13439, city: '/api/pw_cities/1174', name: 'Лісна' }]),
  1051: hydra([{ id: 10874, city: '/api/pw_cities/1051', name: 'І.Вахули' }, { id: 12170, city: '/api/pw_cities/1051', name: 'Івана Франка' }]),
  1805: hydra([{ id: 21408, city: '/api/pw_cities/1805', name: 'Ясінь' }]),
  1046: hydra([]),
};
/** Each street's accounts. Кульпарківська: the saved rows of «95» plus the one row of «32-А» the research saw. */
const ACCOUNTS: Record<string, any[]> = {
  '693/12448': [...membersOf(ACC_95), ...accountRows(693, [['32-А', '3.1']])],
  '1174/13439': membersOf(ACC_1174),
  '1051/10874': accountRows(1051, [['2', '2.1'], ['5', '2.1'], ['7', '2.1'], ['9', '2.1'], ['11', 'Не входить']]),
  '1805/21408': accountRows(1805, [['32-А', '4.1'], ['537', '4.1']]),
};

/** Like the API: `buildingName` filters by the exact text. */
function accounts(q: URLSearchParams): HttpResponse {
  const rows = ACCOUNTS[`${q.get('city.id')}/${q.get('street.id')}`] ?? [];
  const house = q.get('buildingName');
  return ok(hydra(house === null ? rows : rows.filter((r) => r.buildingName === house)));
}

/** Like the API: the rows of the asked city and street. */
const accidentsOf = (rows: any[]) => (q: URLSearchParams): HttpResponse =>
  ok(hydra(rows.filter((r) => String(r.city.id) === q.get('city.id') && String(r.street.id) === q.get('street.id'))));
const ACCIDENT_ROWS = membersOf(ACCIDENTS);
const VAKHULY_ROW = ACCIDENT_ROWS.find((r) => r.street.id === 10874);

/** Routes by origin and path to the saved answers. An unknown request rejects, so a wrong pick fails the test. */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    [`${CMS}/menu_items/238`]: () => ok(TODAY_ITEM),
    [`${CMS}/menu_items/256`]: () => ok(TOMORROW_ITEM),
    [`${CMS}/menus`]: () => ok(MENUS),
    [`${API}/pw_cities`]: () => ok(CITIES),
    [`${API}/pw_streets`]: (q) => (STREETS[q.get('city.id')!] ? ok(STREETS[q.get('city.id')!]) : new Error('no such city')),
    [`${API}/pw_accounts`]: accounts,
    [`${API}/pw_accidents`]: accidentsOf(ACCIDENT_ROWS),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const route = routes[`${u.origin}${u.pathname}`];
    if (!route) throw new Error(`unexpected request ${url}`);
    const r = route(u.searchParams, init);
    if (r instanceof Error) throw r;
    return r;
  });
  const to = (path: string) => calls.filter((c) => {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}`.endsWith(`/api/${path}`);
  });
  return { fetch, calls, to };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

/** The provider with a pinned `now`, and a fake clock that the fake sleep moves on: the 1.5 s spacing costs no time. */
function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: () => Date } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let t = 1_760_000_000_000;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const now = opts.now ?? (() => at('2026-10-17', 20));
  const p = new LoeProvider({ fetch: http.fetch, isOnline: () => true, log, now, sleep, clock: () => t });
  return { p, http, log };
}

async function expectError(p: Promise<unknown>, cls: typeof ProviderError, message: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
  return err as Error;
}

const menusWith = (patch: (archive: any[], items: any[]) => void): string => {
  const m = JSON.parse(MENUS);
  const items = m['hydra:member'][0].menuItems;
  patch(items.find((i: any) => i.name === 'Arhiv').children, items);
  return JSON.stringify(m);
};
const archiveHtml = (id: number): string =>
  JSON.parse(MENUS)['hydra:member'][0].menuItems.find((i: any) => i.name === 'Arhiv').children.find((c: any) => c.id === id).rawHtml;
const OCT17 = archiveHtml(1108);
const withHtml = (item: string, rawHtml: string) => () => ok(JSON.stringify({ ...JSON.parse(item), rawHtml }));
/** 1108's text, re-dated: the schedule for `day` as of `stamp`. */
const redated = (day: string, stamp: string) => OCT17.replace('на 17.10.2026', `на ${day}`).replace('18:56 17.10.2026', stamp);

const KULP: Address = {
  providerId: 'loe', city: 'Львів', street: 'Кульпарківська', house: '95', lineIndex: 1, groupId: '5.1',
};
const VAKHULY: Address = {
  providerId: 'loe', city: 'Старий Яр', street: 'І.Вахули', house: '5', lineIndex: 1, groupId: '2.1',
};
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const offIn = (from: number, to: number): Slot[] => Array.from({ length: 48 }, (_, i): Slot => (i >= from && i < to ? 'off' : 'on'));
/** 17.10, group 5.1: off 12:00-16:00. */
const OCT17_5_1 = offIn(24, 32);

describe('LoeProvider schedule', () => {
  it('a day with Today and Tomorrow empty and nothing in the archive is quiet (20.10)', async () => {
    const { p, http } = setup({ now: () => at('2026-10-20', 10) });
    const snap = await p.fetchSnapshot(KULP);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.note).toBe(LOE_QUIET_NOTE);
    expect(snap.note).toBe('Львівобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає');
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(http.to('menu_items/238')).toHaveLength(1);
    expect(http.to('menu_items/256')).toHaveLength(1);
    const [archive] = http.to('menus');
    expect(archive.url).toMatch(/^https:\/\/api\.loe\.lviv\.ua\/api\/menus\?page=1&type=photo-grafic&_=\d+$/);
  });

  it('on 17.10 at 20:00 the archive\'s latest 17.10 revision is used, whatever the order', async () => {
    for (const menus of [MENUS, menusWith((archive) => archive.reverse())]) {
      const { p } = setup({ http: fakeHttp({ [`${CMS}/menus`]: () => ok(menus) }) });
      const snap = await p.fetchSnapshot(KULP);
      expect(snap.days).toEqual([{ date: '2026-10-17', slots: OCT17_5_1 }]);
      expect(snap.sourceUpdatedAt).toBe('18:56 17.10.2026');
      expect('note' in snap).toBe(false);
      expect(snap).toMatchObject({
        providerId: 'loe', address: KULP, groupId: '5.1', groupLabel: 'Черга 5.1', fetchedAt: at('2026-10-17', 20).toISOString(),
      });
      expect(snap.lines).toEqual([{ index: 1, groupId: '5.1', label: 'Черга 5.1' }, { index: 2, groupId: '5.2', label: 'Черга 5.2' }]);
    }
  });

  it('just after midnight the Tomorrow item headed today gives today\'s schedule, not a quiet day (Review Focus 3)', async () => {
    const http = fakeHttp({ [`${CMS}/menu_items/256`]: withHtml(TOMORROW_ITEM, redated('18.10.2026', '21:40 17.10.2026')) });
    const { p } = setup({ http, now: () => at('2026-10-18', 0, 20) });
    const snap = await p.fetchSnapshot(KULP);
    expect(snap.days).toEqual([{ date: '2026-10-18', slots: OCT17_5_1 }]);
    expect(snap.sourceUpdatedAt).toBe('21:40 17.10.2026');
    expect('note' in snap).toBe(false);
    expect(http.to('menus')).toHaveLength(0);
  });

  it('a Today item headed today is used, and the archive is not read', async () => {
    const http = fakeHttp({ [`${CMS}/menu_items/238`]: withHtml(TODAY_ITEM, redated('17.10.2026', '09:00 17.10.2026')) });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot(KULP);
    expect(snap.sourceUpdatedAt).toBe('09:00 17.10.2026');
    expect(http.to('menus')).toHaveLength(0);
  });

  it('adds tomorrow once it has a revision; today without one is quiet', async () => {
    const { p } = setup({ now: () => at('2026-10-16', 21) });
    const snap = await p.fetchSnapshot(KULP);
    expect(snap.days).toEqual([{ date: '2026-10-16', slots: fill('on') }, { date: '2026-10-17', slots: OCT17_5_1 }]);
    expect(snap.note).toBe(LOE_QUIET_NOTE);
    expect('sourceUpdatedAt' in snap).toBe(false);
  });

  it('a Today item still holding yesterday is ignored and the archive is read', async () => {
    const http = fakeHttp({ [`${CMS}/menu_items/238`]: withHtml(TODAY_ITEM, OCT17) });
    const { p } = setup({ http, now: () => at('2026-10-18', 9) });
    const snap = await p.fetchSnapshot(KULP);
    expect(snap.days).toEqual([{ date: '2026-10-18', slots: fill('on') }]);
    expect(snap.note).toBe(LOE_QUIET_NOTE);
    expect(http.to('menus')).toHaveLength(1);
  });

  it('a Today item with name «Arhiv» is unreadable', async () => {
    const http = fakeHttp({ [`${CMS}/menu_items/238`]: () => ok(JSON.stringify({ ...JSON.parse(TODAY_ITEM), name: 'Arhiv' })) });
    const { p } = setup({ http, now: () => at('2026-10-20', 10) });
    await expectError(p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
  });

  it('a Today or Tomorrow item outside the grammar is unreadable whatever its date', async () => {
    for (const path of ['menu_items/238', 'menu_items/256']) {
      const item = path.endsWith('238') ? TODAY_ITEM : TOMORROW_ITEM;
      const http = fakeHttp({ [`${CMS}/${path}`]: withHtml(item, archiveHtml(540)) });
      const { p } = setup({ http, now: () => at('2026-10-20', 10) });
      await expectError(p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
    }
  });

  it('an archive item headed today outside the grammar is unreadable; another day\'s is skipped', async () => {
    const broken = OCT17.replace('з 20:00 до 22:00', 'з 20:00 до 20:00');
    const http = fakeHttp({ [`${CMS}/menus`]: () => ok(menusWith((archive) => { archive[8].rawHtml = broken; })) });
    const { p } = setup({ http });
    await expectError(p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
    // Item 540 (12.08.2024, zero-length ranges) sits in the archive of every other test and never fails them.
  });

  it('an archive without «Arhiv» is unreadable, never a quiet day', async () => {
    const http = fakeHttp({ [`${CMS}/menus`]: () => ok(menusWith((_, items) => { items.splice(1, 1); })) });
    const { p } = setup({ http, now: () => at('2026-10-20', 10) });
    await expectError(p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
  });

  it('the schedule failing is an error, never a quiet day', async () => {
    const rejected = setup({ http: fakeHttp({ [`${CMS}/menu_items/238`]: () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(KULP), ProviderError, NO_ANSWER);
    const limited = setup({ http: fakeHttp({ [`${CMS}/menus`]: () => failStatus(429) }), now: () => at('2026-10-20', 10) });
    await expectError(limited.p.fetchSnapshot(KULP), ProviderError, NO_ANSWER);
    const html = setup({ http: fakeHttp({ [`${CMS}/menu_items/256`]: () => ok('<html>Just a moment…</html>') }) });
    const err = await expectError(html.p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
    expect(JSON.stringify(err.cause)).not.toContain('Just a moment');
  });

  it('a saved queue the revision lacks is unreadable', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => ok(hydra(accountRows(693, [['95', '7.1']]))) });
    const { p } = setup({ http });
    await expectError(p.fetchSnapshot({ ...KULP, groupId: '7.1' }), ProviderError, UNREADABLE);
  });

  it('a house out of the schedule saved as none is all on without reading the schedule', async () => {
    const { p, http } = setup({ now: () => at('2026-10-20', 15) });
    const snap = await p.fetchSnapshot({ ...VAKHULY, house: '11', groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
    expect(snap.groupLabel).toBe('Не входить до ГПВ');
    expect('note' in snap).toBe(false);
    expect(http.calls.filter((c) => c.url.startsWith(CMS))).toHaveLength(0);
    expect(http.to('pw_accidents')).toHaveLength(1);
  });

  it('a moved queue gives today unknown and the new lines, without reading the schedule', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...KULP, house: '32-А', groupId: '5.1' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('unknown') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: '3.1', label: 'Черга 3.1' }]);
    expect(snap.groupLabel).toBe('Черга 5.1');
    expect('note' in snap).toBe(false);
    expect(http.calls.filter((c) => c.url.startsWith(CMS))).toHaveLength(0);
    // A house saved as none that joined a queue is a moved line too.
    const none = await setup().p.fetchSnapshot({ ...KULP, groupId: 'none' });
    expect(none.days).toEqual([{ date: '2026-10-17', slots: fill('unknown') }]);
  });
});

describe('LoeProvider address lookup', () => {
  it('listCities drops the non-UA46 rows and labels «Винники» with their громада', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toHaveLength(58);
    expect(cities).toContain('Львів');
    expect(cities).toContain('Винники (Львівська громада)');
    expect(cities).toContain('Винники (Бориславська громада)');
    expect(cities).not.toContain('Винники');
    expect(cities).toContain('Брюховичі (Львівська громада)');
    expect(cities).toContain('Червоноград');
    // Тернопіль (UA61…) and Київ (empty codeOtg) are rows of other oblasts.
    expect(cities.some((c) => c.startsWith('Тернопіль') || c.startsWith('Київ'))).toBe(false);
    expect(cities).toEqual([...cities].sort((a, b) => a.localeCompare(b, 'uk')));
    expect(http.calls.map((c) => c.url)).toEqual([`${API}/pw_cities?pagination=false&otg.id=`]);
  });

  it('keeps the city list for the run', async () => {
    const { p, http } = setup();
    await p.listCities();
    await p.listCities();
    await p.listStreets('Львів');
    expect(http.to('pw_cities')).toHaveLength(1);
  });

  it('accepts the city list as a plain array too', async () => {
    const http = fakeHttp({ [`${API}/pw_cities`]: () => ok(JSON.stringify(membersOf(CITIES))) });
    const { p } = setup({ http });
    expect(await p.listCities()).toEqual(await setup().p.listCities());
  });

  it('a city list with no Lviv-oblast row, or of another shape, is unreadable', async () => {
    const other = setup({ http: fakeHttp({ [`${API}/pw_cities`]: () => ok(hydra([{ id: 1, name: 'Київ', codeOtg: '' }])) }) });
    await expectError(other.p.listCities(), ProviderError, UNREADABLE);
    const odd = setup({ http: fakeHttp({ [`${API}/pw_cities`]: () => ok('{"cities":[]}') }) });
    await expectError(odd.p.listCities(), ProviderError, UNREADABLE);
  });

  it('listStreets resolves the city to its id and sorts the names', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets('Львів');
    expect(streets).toHaveLength(80);
    expect(streets).toContain('Кульпарківська');
    expect(streets).toEqual([...streets].sort((a, b) => a.localeCompare(b, 'uk')));
    expect(http.to('pw_streets').map((c) => c.url)).toEqual([`${API}/pw_streets?pagination=false&city.id=693`]);
  });

  it('Червоноград\'s listStreets is []', async () => {
    const { p } = setup();
    expect(await p.listStreets('Червоноград')).toEqual([]);
    const array = setup({ http: fakeHttp({ [`${API}/pw_streets`]: () => ok('[]') }) });
    expect(await array.p.listStreets('Червоноград')).toEqual([]);
  });

  it('pw_streets in the Hydra shape and in the array shape give the same list', async () => {
    const asHydra = fakeHttp({ [`${API}/pw_streets`]: () => ok(hydra(JSON.parse(STREETS_693))) });
    const fromHydra = await setup({ http: asHydra }).p.listStreets('Львів');
    const fromArray = await setup().p.listStreets('Львів');
    expect(fromHydra).toHaveLength(80);
    expect(fromHydra).toEqual(fromArray);
  });

  it('street names are trimmed, and a repeated one is numbered by id whatever the order (R6)', async () => {
    const two = [{ id: 7, name: 'Стрийська - Наукова ' }, { id: 3, name: 'Стрийська - Наукова' }];
    for (const streets of [two, [...two].reverse()]) {
      const { p, http } = setup({ http: fakeHttp({ [`${API}/pw_streets`]: () => ok(JSON.stringify(streets)) }) });
      expect(await p.listStreets('Львів')).toEqual(['Стрийська - Наукова', 'Стрийська - Наукова (2)']);
      await p.listHouses('Львів', 'Стрийська - Наукова (2)');
      expect(http.to('pw_accounts').map((c) => new URL(c.url).searchParams.get('street.id'))).toEqual(['7']);
    }
  });

  it('a numbered namesake city keeps its record whatever order the API lists them in (R6)', async () => {
    const rows = membersOf(CITIES);
    const lviv = rows.find((c) => c.id === 693);
    const twins = [...rows, { ...lviv, id: 9001, name: 'Двійня' }, { ...lviv, id: 9000, name: 'Двійня' }];
    for (const list of [twins, [...twins].reverse()]) {
      const http = fakeHttp({ [`${API}/pw_cities`]: () => ok(hydra(list)), [`${API}/pw_streets`]: () => ok('[]') });
      const { p } = setup({ http });
      const labels = await p.listCities();
      expect(labels.filter((l) => l.startsWith('Двійня'))).toEqual(['Двійня (Львівська громада)', 'Двійня (Львівська громада) (2)']);
      await p.listStreets('Двійня (Львівська громада)');
      await p.listStreets('Двійня (Львівська громада) (2)');
      expect(http.to('pw_streets').map((c) => new URL(c.url).searchParams.get('city.id'))).toEqual(['9000', '9001']);
    }
  });

  it('an ambiguous bare city label is not found', async () => {
    const { p } = setup();
    await expectError(p.listStreets('Винники'), AddressNotFoundError, NOT_FOUND);
  });

  it('listHouses on Кульпарківська merges accounts per building: «95» has 5.1 and 5.2', async () => {
    const { p, http } = setup();
    const houses = await p.listHouses('Львів', 'Кульпарківська');
    expect(houses).toEqual([
      { house: '32-А', lines: [{ index: 1, groupId: '3.1', label: 'Черга 3.1' }], outageActive: false },
      {
        house: '95',
        lines: [{ index: 1, groupId: '5.1', label: 'Черга 5.1' }, { index: 2, groupId: '5.2', label: 'Черга 5.2' }],
        outageActive: false,
      },
    ]);
    expect(http.to('pw_accounts').map((c) => c.url)).toEqual([`${API}/pw_accounts?pagination=false&city.id=693&street.id=12448`]);
  });

  it('listHouses gives each house once, in house order, with «Не входить» as the always-on line', async () => {
    const { p } = setup();
    const houses = await p.listHouses('Брюховичі (Львівська громада)', 'Лісна');
    expect(houses.map((h) => h.house)).toEqual(['2', '4', '6', '8', '10', '12', '14', '16', '16-А', '18', '20', '22', '24', '26', '28', '32']);
    expect(houses[0].lines).toEqual([{ index: 1, groupId: '2.1', label: 'Черга 2.1' }]);
    const stary = await setup().p.listHouses('Старий Яр', 'І.Вахули');
    expect(stary.find((h) => h.house === '11')?.lines).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
  });

  it('listHouses skips rows with an empty house and keeps the house text byte for byte', async () => {
    const http = fakeHttp({
      [`${API}/pw_accounts`]: () => ok(hydra(accountRows(693, [['', '1.1'], ['64 - А', '1.1'], [' ', '1.2'], ['59,61,63', '2.2']]))),
    });
    const { p } = setup({ http });
    expect((await p.listHouses('Львів', 'Кульпарківська')).map((h) => h.house)).toEqual(['59,61,63', '64 - А']);
  });

  it('an account row of another shape is unreadable', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => ok(hydra([{ buildingName: '1', chergGpv: null }])) });
    const { p } = setup({ http });
    await expectError(p.listHouses('Львів', 'Кульпарківська'), ProviderError, UNREADABLE);
  });
});

describe('LoeProvider.fetchSnapshot address check', () => {
  it('sends buildingName exactly (32-А, Cyrillic А)', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot({ ...KULP, house: '32-А', groupId: '3.1' });
    const [check] = http.to('pw_accounts');
    expect(check.url).toBe(`${API}/pw_accounts?pagination=false&city.id=693&street.id=12448&buildingName=32-%D0%90`);
    expect(new URL(check.url).searchParams.get('buildingName')).toBe('32-А');
  });

  it('encodes a house with spaces as %20, never +', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => ok(hydra(accountRows(693, [['64 - А', '5.1']]))) });
    const { p } = setup({ http });
    await p.fetchSnapshot({ ...KULP, house: '64 - А' });
    expect(http.to('pw_accounts')[0].url).toContain('&buildingName=64%20-%20%D0%90');
  });

  it('accounts gone throws AddressNotFoundError without reading the schedule', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...KULP, house: '999' }), AddressNotFoundError, NOT_FOUND);
    expect(http.calls.filter((c) => c.url.startsWith(CMS))).toHaveLength(0);
  });

  it('a city or street label that no longer resolves is not found', async () => {
    const { p } = setup();
    await expectError(p.fetchSnapshot({ ...KULP, city: 'Неіснуюче' }), AddressNotFoundError, NOT_FOUND);
    await expectError(p.fetchSnapshot({ ...KULP, street: 'Неіснуюча' }), AddressNotFoundError, NOT_FOUND);
    await expectError(p.fetchSnapshot({ ...KULP, city: 'Винники' }), AddressNotFoundError, NOT_FOUND);
  });

  it('a rejected pw_accounts still delivers the schedule with the saved line (R2)', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => new Error('ECONNRESET') });
    const { p, log } = setup({ http });
    const snap = await p.fetchSnapshot({ ...KULP, lineIndex: 2, groupId: '5.2' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: offIn(28, 34) }]);
    expect(snap.lines).toEqual([{ index: 2, groupId: '5.2', label: 'Черга 5.2' }]);
    expect('currentOutage' in snap).toBe(false);
    expect(http.to('pw_accidents')).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^loe fetchSnapshot: /), expect.any(ProviderError));
  });

  it('a rejected city list or an unreadable street list is soft too, and the log carries no body', async () => {
    const noCities = setup({ http: fakeHttp({ [`${API}/pw_cities`]: () => failStatus(429) }) });
    const a = await noCities.p.fetchSnapshot(KULP);
    expect(a.days).toEqual([{ date: '2026-10-17', slots: OCT17_5_1 }]);
    expect(a.lines).toEqual([{ index: 1, groupId: '5.1', label: 'Черга 5.1' }]);
    const html = setup({ http: fakeHttp({ [`${API}/pw_streets`]: () => ok('<html>Just a moment… Кульпарківська</html>') }) });
    const b = await html.p.fetchSnapshot(KULP);
    expect(b.days).toEqual([{ date: '2026-10-17', slots: OCT17_5_1 }]);
    expect(html.log.warn).toHaveBeenCalled();
    const logged = JSON.stringify(html.log.warn.mock.calls, (_k, v: unknown) => (v instanceof Error ? { m: v.message, c: v.cause } : v));
    expect(logged).not.toContain('Just a moment');
  });

  it('a soft address failure with the none line is still all on', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => failStatus(500) });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot({ ...KULP, groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: fill('on') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }]);
  });

  it('a soft address failure does not hide a broken schedule', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => new Error('ECONNRESET'), [`${CMS}/menus`]: () => ok('{}') });
    const { p } = setup({ http, now: () => at('2026-10-20', 10) });
    await expectError(p.fetchSnapshot(KULP), ProviderError, UNREADABLE);
  });
});

describe('LoeProvider current outage', () => {
  it('a typeOff 1 row covering now is an emergency with Kyiv-formatted times', async () => {
    const { p, http } = setup({ now: () => at('2026-10-20', 15) });
    const snap = await p.fetchSnapshot(VAKHULY);
    expect(snap.currentOutage).toEqual({
      kind: 'emergency', text: 'Аварійне вимкнення', start: '13:09 20.10.2026', end: '20:00 20.10.2026',
    });
    expect(http.to('pw_accidents').map((c) => c.url)).toEqual([`${API}/pw_accidents?page=1&city.id=1051&street.id=10874`]);
  });

  it('counts from its start and until its end', async () => {
    for (const [h, m, running] of [[13, 8, false], [13, 9, true], [19, 59, true], [20, 0, false]] as const) {
      const { p } = setup({ now: () => at('2026-10-20', h, m) });
      expect('currentOutage' in await p.fetchSnapshot(VAKHULY)).toBe(running);
    }
  });

  it('a row without an end counts once it has started', async () => {
    const http = fakeHttp({ [`${API}/pw_accidents`]: accidentsOf([{ ...VAKHULY_ROW, datePlanIn: null }]) });
    const { p } = setup({ http, now: () => at('2026-10-21', 9) });
    expect((await p.fetchSnapshot(VAKHULY)).currentOutage).toEqual({ kind: 'emergency', text: 'Аварійне вимкнення', start: '13:09 20.10.2026' });
  });

  it('converts the instants to Kyiv time, whatever their offset', async () => {
    const http = fakeHttp({
      [`${API}/pw_accidents`]: accidentsOf([{ ...VAKHULY_ROW, dateEvent: '2026-10-20T10:09:00Z', datePlanIn: '2026-10-20T17:00:00+00:00' }]),
    });
    const { p } = setup({ http, now: () => at('2026-10-20', 15) });
    expect((await p.fetchSnapshot(VAKHULY)).currentOutage).toMatchObject({ start: '13:09 20.10.2026', end: '20:00 20.10.2026' });
  });

  it('typeOff 30 and 2 are other; 0 is planned', async () => {
    for (const [typeOff, kind, text] of [
      [30, 'other', 'Можливе аварійне вимкнення'], [2, 'other', 'Оперативні перемикання'], [0, 'planned', 'Планове вимкнення'],
    ] as const) {
      const http = fakeHttp({ [`${API}/pw_accidents`]: accidentsOf([{ ...VAKHULY_ROW, typeOff }]) });
      const { p } = setup({ http, now: () => at('2026-10-20', 15) });
      expect((await p.fetchSnapshot(VAKHULY)).currentOutage).toMatchObject({ kind, text });
    }
  });

  it('an unknown typeOff, another house or a row of another street does not count', async () => {
    for (const row of [
      { ...VAKHULY_ROW, typeOff: 5 },
      { ...VAKHULY_ROW, buildingNames: '2, 7, 9, 55' },
      { ...VAKHULY_ROW, street: { ...VAKHULY_ROW.street, id: 12170 } },
    ]) {
      // The router answers every row here, as an API ignoring the street filter would.
      const http = fakeHttp({ [`${API}/pw_accidents`]: () => ok(hydra([row])) });
      const { p } = setup({ http, now: () => at('2026-10-20', 15) });
      expect('currentOutage' in await p.fetchSnapshot(VAKHULY)).toBe(false);
    }
  });

  it('the planned works at Буковинка, Ясінь reach house «32-А» of its comma list', async () => {
    const { p } = setup({ now: () => at('2026-10-20', 12) });
    const snap = await p.fetchSnapshot({ ...VAKHULY, city: 'Буковинка', street: 'Ясінь', house: '32-А', groupId: '4.1' });
    expect(snap.currentOutage).toEqual({ kind: 'planned', text: 'Планове вимкнення', start: '09:33 20.10.2026', end: '19:00 20.10.2026' });
  });

  it('a house written as a comma list matches a row naming one of its parts', async () => {
    const http = fakeHttp({
      [`${API}/pw_accounts`]: () => ok(hydra(accountRows(1051, [['3, 5', '2.1']]))),
    });
    const { p } = setup({ http, now: () => at('2026-10-20', 15) });
    expect((await p.fetchSnapshot({ ...VAKHULY, house: '3, 5' })).currentOutage?.kind).toBe('emergency');
  });

  it('an emergency wins over planned works and other switching', async () => {
    const rows = [{ ...VAKHULY_ROW, typeOff: 30 }, { ...VAKHULY_ROW, typeOff: 0 }, VAKHULY_ROW];
    const { p } = setup({ http: fakeHttp({ [`${API}/pw_accidents`]: accidentsOf(rows) }), now: () => at('2026-10-20', 15) });
    expect((await p.fetchSnapshot(VAKHULY)).currentOutage?.kind).toBe('emergency');
  });

  it('the outage applies to a house out of the schedule too', async () => {
    const http = fakeHttp({ [`${API}/pw_accounts`]: () => ok(hydra(accountRows(1051, [['5', 'Не входить']]))) });
    const { p } = setup({ http, now: () => at('2026-10-20', 15) });
    const snap = await p.fetchSnapshot({ ...VAKHULY, groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.currentOutage?.kind).toBe('emergency');
  });

  it('the redacted koment never reaches the snapshot or the log', async () => {
    const { p, log } = setup({ now: () => at('2026-10-20', 12) });
    const snaps = [
      await p.fetchSnapshot({ ...VAKHULY, city: 'Буковинка', street: 'Ясінь', house: '32-А', groupId: '4.1' }),
      await p.fetchSnapshot(VAKHULY),
    ];
    expect(snaps[0].currentOutage?.kind).toBe('planned');
    const text = JSON.stringify([snaps, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    for (const k of ['redacted', 'Пошкодження', 'дерев', 'koment']) expect(text).not.toContain(k);
  });

  it('a rejected or odd pw_accidents still delivers the schedule', async () => {
    for (const route of [() => new Error('ECONNRESET'), () => ok('{"hydra:member":{}}'), () => ok('<html></html>')]) {
      const { p, log } = setup({ http: fakeHttp({ [`${API}/pw_accidents`]: route }) });
      const snap = await p.fetchSnapshot(KULP);
      expect(snap.days).toEqual([{ date: '2026-10-17', slots: OCT17_5_1 }]);
      expect('currentOutage' in snap).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^loe /), expect.anything());
    }
  });
});

describe('LoeProvider requests', () => {
  it('two requests start at least 1500 ms apart (fake clock and sleep)', async () => {
    let t = 5_000;
    const starts: number[] = [];
    const http = fakeHttp();
    const fetch: HttpFetch = (url, init) => { starts.push(t); return http.fetch(url, init); };
    const sleep = vi.fn(async (ms: number) => { t += ms; });
    const p = new LoeProvider({ fetch, isOnline: () => true, now: () => at('2026-10-17', 20), sleep, clock: () => t });
    await p.listCities();
    t += 200;
    await p.listStreets('Львів');
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1500);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1300);
  });

  it('every request is a GET with Accept: application/ld+json and a timeout', async () => {
    const { p, http } = setup({ now: () => at('2026-10-20', 15) });
    await p.listCities();
    await p.listHouses('Львів', 'Кульпарківська');
    await p.fetchSnapshot(VAKHULY);
    expect(http.calls.length).toBeGreaterThan(6);
    for (const c of http.calls) {
      expect(c.init.method).toBe('GET');
      expect(c.init.headers).toEqual({ Accept: 'application/ld+json' });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
