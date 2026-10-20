// SYNTHETIC-schedule-active-shape.json is HAND-BUILT, not a real response: no day with outages has been seen live from
// off.energy.mk.ua. Every other fixture is the real answer of 20.10.2026; street 2967's house list and the outage-queue
// answers of houses other than 115392 are made in the test, in the API's shape.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MKOE_QUIET_NOTE, MkoeProvider } from '../../src/main/providers/mkoe';
import { mkoeSettlements } from '../../src/main/providers/mkoe/settlements';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const fx = (n: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'mkoe', n), 'utf8');
const SYNTHETIC = fx('SYNTHETIC-schedule-active-shape.json');
const QUIET = fx('schedule-active-2026-10-20.json');
const TIME_SERIES = fx('time-series-2026-10-20.json');
const QUEUES = fx('queues-type3-2026-10-20.json');
const STREETS_171 = fx('ns171-streets-2026-10-20.json');
const HOUSES_2968 = fx('street2968-houses-2026-10-20.json');
const DOM_115392 = fx('dom115392-outage-queue-2026-10-20.json');

const ORIGIN = 'https://off.energy.mk.ua';
const API = `${ORIGIN}/api`;
const NAME = 'Миколаївобленерго';
const UNREADABLE = `Не вдалося прочитати графік ${NAME}`;
const NO_ANSWER = `Сайт ${NAME} не відповідає`;
const HTTP_ERROR = `Сайт ${NAME} повернув помилку`;
const OFFLINE = `Немає з’єднання з сайтом ${NAME}`;
const NOT_FOUND = `Адресу не знайдено у ${NAME} — оберіть її в налаштуваннях заново`;

type Init = Parameters<HttpFetch>[1];
type Route = (init: Init) => HttpResponse | Error;

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});

const TYPE_NAME: Record<number, string> = { 1: 'ГАВ', 2: 'СГАВ', 3: 'ГПВ' };
/** One `outage-queue` row of the API's shape. */
const queueRow = (id: number, name: string, typeId: number, enabled = 0) => ({
  outage: { id, name, type_id: typeId, enabled, created_at: null, updated_at: '2026-10-17T20:24:52.000000Z', deleted: 0 },
  outageType: { id: typeId, name: TYPE_NAME[typeId], created_at: null, updated_at: null },
});
const queueRows = (...rows: ReturnType<typeof queueRow>[]) => JSON.stringify(rows);
/** A `queueRow` with some `outage` fields changed. */
const patched = (row: ReturnType<typeof queueRow>, patch: Record<string, unknown>) => ({ ...row, outage: { ...row.outage, ...patch } });
/** House answers of a shape we do not know, with the reason: a ГПВ name outside N.M, a deleted ГПВ row, an unknown type. */
const ODD_HOUSES: [string, string][] = [
  ['queue name', JSON.stringify([queueRow(40, '7', 3), queueRow(12, '2', 2)])],
  ['deleted', JSON.stringify([patched(queueRow(17, '2.2', 3), { deleted: 1 }), queueRow(12, '2', 2)])],
  ['type', JSON.stringify([queueRow(50, '1', 4), queueRow(12, '2', 2)])],
];
/** House 115392's real answer with the queue of this id switched on. */
const dom115392Enabled = (...ids: number[]) => JSON.stringify(
  JSON.parse(DOM_115392).map((r: any) => (ids.includes(r.outage.id) ? { ...r, outage: { ...r.outage, enabled: 1 } } : r)),
);

/** вул. Маріупольська (2967): only these two of its houses, as the research sampled them. */
const HOUSES_2967 = JSON.stringify([{ iddom: 115392, nazdom: '14' }, { iddom: 115414, nazdom: '35' }]);
/** Each house's `outage-queue`: 115392 is the saved answer; the rest are made up (1 on Шевченка: ГАВ and СГАВ only). */
const OUTAGE_QUEUES: Record<string, string> = {
  115392: DOM_115392,
  115414: queueRows(queueRow(21, '4.1', 3), queueRow(25, '5.2', 3), queueRow(35, '7(Р)', 1), queueRow(36, '8(Р)', 1)),
  124212: queueRows(queueRow(12, '2', 2), queueRow(33, '5(Р)', 1)),
  124213: queueRows(queueRow(19, '3.1', 3), queueRow(12, '2', 2)),
};

/** Routes by path to the saved answers. An unknown request rejects, so a wrong pick fails the test. */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    '/api/v2/schedule/active': () => ok(QUIET),
    '/api/schedule/time-series': () => ok(TIME_SERIES),
    '/api/outage-queue/by-type/3': () => ok(QUEUES),
    '/api/addr/ns/171/street': () => ok(STREETS_171),
    '/api/addr/street/2968/dom': () => ok(HOUSES_2968),
    '/api/addr/street/2967/dom': () => ok(HOUSES_2967),
    ...Object.fromEntries(Object.entries(OUTAGE_QUEUES).map(([id, body]) => [`/api/addr/dom/${id}/outage-queue`, () => ok(body)])),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const route = u.origin === ORIGIN && u.search === '' ? routes[u.pathname] : undefined;
    if (!route) throw new Error(`unexpected request ${url}`);
    const r = route(init);
    if (r instanceof Error) throw r;
    return r;
  });
  const to = (path: string) => calls.filter((c) => new URL(c.url).pathname === `/api/${path}`);
  const schedule = () => calls.filter((c) => /\/(schedule|outage-queue\/by-type)\//.test(new URL(c.url).pathname));
  return { fetch, calls, to, schedule };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: () => Date; online?: boolean } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const now = opts.now ?? (() => at('2026-10-20', 12));
  const p = new MkoeProvider({ fetch: http.fetch, isOnline: () => opts.online ?? true, log, now });
  return { p, http, log };
}

async function expectError(p: Promise<unknown>, cls: typeof ProviderError, message: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
  return err as Error;
}

const CITY = 'м. Миколаїв';
const MARIUPOLSKA: Address = {
  providerId: 'mkoe', city: CITY, street: 'вул. Маріупольська', house: '14', lineIndex: 1, groupId: '2.2',
};
/** Шевченка 1: only ГАВ and СГАВ, so the always-on line. */
const SHEVCHENKA_1: Address = {
  providerId: 'mkoe', city: CITY, street: 'вул. Шевченка', house: '1', lineIndex: 1, groupId: 'none',
};
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const slotsWith = (marks: Record<number, Slot>): Slot[] => fill('on').map((s, i) => marks[i] ?? s);
/** The synthetic 20.10 and 21.10 of queue 2.2. */
const OCT20_2_2 = slotsWith({ 20: 'off', 21: 'off', 22: 'maybe-off', 23: 'maybe-off', 28: 'off' });
const OCT21_2_2 = slotsWith({ 0: 'off', 1: 'off', 2: 'off', 3: 'off' });
const LINES_115392 = [{ index: 1, groupId: '2.2', label: 'Черга 2.2' }, { index: 2, groupId: '5.2', label: 'Черга 5.2' }];
const NONE_LINE = [{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }];
const withSynthetic = (over: Record<string, Route> = {}) => fakeHttp({ '/api/v2/schedule/active': () => ok(SYNTHETIC), ...over });
/** The log calls as text, errors with their message and cause: what a log line could carry. */
const logged = (log: ReturnType<typeof setup>['log']) => JSON.stringify(
  [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls],
  (_k, v: unknown) => (v instanceof Error ? { m: v.message, c: v.cause } : v),
);

describe('MkoeProvider address lookup', () => {
  it('listCities is the bundled list and makes no request', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toEqual(mkoeSettlements().map((s) => s.label));
    expect(cities).toContain(CITY);
    expect(cities).toContain('м. Миколаїв (Корабельний)');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('listStreets(«м. Миколаїв») requests /addr/ns/171/street; names are trimmed, numbered and sorted', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets(CITY);
    expect(http.calls.map((c) => c.url)).toEqual([`${API}/addr/ns/171/street`]);
    expect(streets).toHaveLength(736);
    expect(streets).toContain('вул. Маріупольська');
    expect(streets).toContain('вул. І. Франка');
    expect(streets).not.toContain('вул. І. Франка ');
    expect(streets.filter((s) => s.startsWith('пров. Вільний'))).toEqual(['пров. Вільний', 'пров. Вільний (2)']);
    expect(streets).toEqual([...streets].sort((a, b) => a.localeCompare(b, 'uk')));
  });

  it('a namesake settlement resolves through its дільниця', async () => {
    const http = fakeHttp({ '/api/addr/ns/7/street': () => ok('[{"idstreet":1,"nazstreet":"вул. Миру"}]') });
    const { p } = setup({ http });
    expect(await p.listStreets('Костянтинівка (Арбузинська дільниця)')).toEqual(['вул. Миру']);
    expect(http.calls.map((c) => c.url)).toEqual([`${API}/addr/ns/7/street`]);
  });

  it('an unknown or ambiguous city label is not found, with no request', async () => {
    const { p, http } = setup();
    await expectError(p.listStreets('Неіснуюче'), AddressNotFoundError, NOT_FOUND);
    await expectError(p.listStreets('Костянтинівка'), AddressNotFoundError, NOT_FOUND);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('a numbered street keeps its record whatever order the API lists them in (R6)', async () => {
    const rows = JSON.parse(STREETS_171);
    for (const list of [rows, [...rows].reverse()]) {
      const http = fakeHttp({ '/api/addr/ns/171/street': () => ok(JSON.stringify(list)), '/api/addr/street/3457/dom': () => ok('[]') });
      const { p } = setup({ http });
      expect((await p.listStreets(CITY)).filter((s) => s.startsWith('пров. Вільний'))).toEqual(['пров. Вільний', 'пров. Вільний (2)']);
      expect(await p.listHouses(CITY, 'пров. Вільний (2)')).toEqual([]);
      expect(http.to('addr/street/3457/dom')).toHaveLength(1);
    }
  });

  it('keeps the street and house lists for the run', async () => {
    const { p, http } = setup();
    await p.listStreets(CITY);
    await p.listStreets(CITY);
    await p.listHouses(CITY, 'вул. Шевченка');
    await p.listHouses(CITY, 'вул. Шевченка');
    await p.houseLines(CITY, 'вул. Шевченка', '1');
    expect(http.to('addr/ns/171/street')).toHaveLength(1);
    expect(http.to('addr/street/2968/dom')).toHaveLength(1);
  });

  it('listHouses gives every house with its lines pending, in house order', async () => {
    const { p, http } = setup();
    const houses = await p.listHouses(CITY, 'вул. Шевченка');
    expect(http.to('addr/street/2968/dom').map((c) => c.url)).toEqual([`${API}/addr/street/2968/dom`]);
    expect(houses).toHaveLength(133);
    expect(houses[0]).toEqual({ house: '1', lines: [], outageActive: false, linesPending: true });
    for (const h of houses) expect(h).toEqual({ house: h.house, lines: [], outageActive: false, linesPending: true });
    // The API lists them as text («1», «1А», «10», «11»…); the wizard shows them in number order.
    expect(houses.slice(0, 8).map((h) => h.house)).toEqual(['1', '1А', '2', '2А', '3', '3/3А', '3А', '4']);
  });

  it('house names are trimmed, and a repeated one is numbered by iddom whatever the order', async () => {
    const two = [{ iddom: 9, nazdom: '52А ' }, { iddom: 5, nazdom: '52А' }];
    for (const list of [two, [...two].reverse()]) {
      const http = fakeHttp({
        '/api/addr/street/2968/dom': () => ok(JSON.stringify(list)),
        '/api/addr/dom/9/outage-queue': () => ok(queueRows(queueRow(16, '2.1', 3))),
      });
      const { p } = setup({ http });
      expect((await p.listHouses(CITY, 'вул. Шевченка')).map((h) => h.house)).toEqual(['52А', '52А (2)']);
      expect(await p.houseLines(CITY, 'вул. Шевченка', '52А (2)')).toEqual([{ index: 1, groupId: '2.1', label: 'Черга 2.1' }]);
    }
  });

  it('houseLines on house 115392 gives both of its ГПВ queues (the saved answer has 2.2 and 5.2)', async () => {
    const { p, http } = setup();
    expect(await p.houseLines(CITY, 'вул. Маріупольська', '14')).toEqual(LINES_115392);
    expect(http.calls.map((c) => c.url)).toEqual([
      `${API}/addr/ns/171/street`, `${API}/addr/street/2967/dom`, `${API}/addr/dom/115392/outage-queue`,
    ]);
  });

  it('a house with only ГАВ and СГАВ rows, or none at all, gives the always-on line', async () => {
    const { p } = setup();
    expect(await p.houseLines(CITY, 'вул. Шевченка', '1')).toEqual(NONE_LINE);
    const empty = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': () => ok('[]') }) });
    expect(await empty.p.houseLines(CITY, 'вул. Шевченка', '1')).toEqual(NONE_LINE);
  });

  it('a house answer of an unknown shape is unreadable, never the always-on line (R11)', async () => {
    for (const [reason, body] of ODD_HOUSES) {
      const { p } = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': () => ok(body) }) });
      const err = await expectError(p.houseLines(CITY, 'вул. Шевченка', '1'), ProviderError, UNREADABLE);
      expect(err.cause).toEqual({ what: 'outage-queue', reason });
    }
    // Next to a known queue too.
    const mixed = queueRows(queueRow(17, '2.2', 3), queueRow(40, '7', 3));
    const { p } = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': () => ok(mixed) }) });
    await expectError(p.houseLines(CITY, 'вул. Шевченка', '1'), ProviderError, UNREADABLE);
  });

  it('a house row whose deleted is not 0 or 1 is unreadable (R11)', async () => {
    for (const deleted of [null, '0', 2, false, undefined]) {
      const body = JSON.stringify([patched(queueRow(17, '2.2', 3), { deleted })]);
      const { p } = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': () => ok(body) }) });
      await expectError(p.houseLines(CITY, 'вул. Шевченка', '1'), ProviderError, UNREADABLE);
    }
  });

  it('houseLines for a house the list does not have is not found', async () => {
    const { p, http } = setup();
    await expectError(p.houseLines(CITY, 'вул. Шевченка', '999'), AddressNotFoundError, NOT_FOUND);
    expect(http.calls.some((c) => c.url.endsWith('/outage-queue'))).toBe(false);
  });

  it('an odd street list, house list or outage-queue is unreadable in the wizard, and the error carries no body', async () => {
    for (const [path, body, call] of [
      ['/api/addr/ns/171/street', '<html>Server Error вул. Шевченка</html>', (p: MkoeProvider) => p.listStreets(CITY)],
      ['/api/addr/ns/171/street', '{}', (p: MkoeProvider) => p.listStreets(CITY)],
      ['/api/addr/ns/171/street', '[{"idstreet":"2968","nazstreet":"вул. Шевченка"}]', (p: MkoeProvider) => p.listStreets(CITY)],
      ['/api/addr/street/2968/dom', '[{"iddom":1}]', (p: MkoeProvider) => p.listHouses(CITY, 'вул. Шевченка')],
      ['/api/addr/dom/124212/outage-queue', '[{"outageType":{"id":3}}]', (p: MkoeProvider) => p.houseLines(CITY, 'вул. Шевченка', '1')],
      ['/api/addr/dom/124212/outage-queue', '{"data":[]}', (p: MkoeProvider) => p.houseLines(CITY, 'вул. Шевченка', '1')],
    ] as const) {
      const { p, log } = setup({ http: fakeHttp({ [path]: () => ok(body) }) });
      const err = await expectError(call(p), ProviderError, UNREADABLE);
      expect(JSON.stringify(err.cause)).not.toContain('Шевченка');
      expect(logged(log)).not.toContain('Server Error');
    }
  });

  it('a request failing in the wizard is that error', async () => {
    const rejected = setup({ http: fakeHttp({ '/api/addr/ns/171/street': () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.listStreets(CITY), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => failStatus(500) }) });
    await expectError(server.p.houseLines(CITY, 'вул. Маріупольська', '14'), ProviderError, HTTP_ERROR);
  });
});

describe('MkoeProvider schedule', () => {
  it('a quiet day on 20.10 (the real []) is all on with the note', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.note).toBe(MKOE_QUIET_NOTE);
    expect(snap.note).toBe('Миколаївобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає');
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(snap).toMatchObject({
      providerId: 'mkoe', address: MARIUPOLSKA, groupId: '2.2', groupLabel: 'Черга 2.2', fetchedAt: at('2026-10-20', 12).toISOString(),
    });
    expect(snap.lines).toEqual(LINES_115392);
    expect('currentOutage' in snap).toBe(false);
    for (const path of ['v2/schedule/active', 'schedule/time-series', 'outage-queue/by-type/3']) expect(http.to(path)).toHaveLength(1);
  });

  it('the synthetic day gives today and tomorrow of the saved queue, and the update time', async () => {
    const { p } = setup({ http: withSynthetic() });
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_2_2 }, { date: '2026-10-21', slots: OCT21_2_2 }]);
    expect(snap.sourceUpdatedAt).toBe('22:40 19.10.2026');
    expect('note' in snap).toBe(false);
  });

  it('today without a row is quiet; tomorrow is there once it has one', async () => {
    const { p } = setup({ http: withSynthetic(), now: () => at('2026-10-19', 22) });
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect(snap.days).toEqual([{ date: '2026-10-19', slots: fill('on') }, { date: '2026-10-20', slots: OCT20_2_2 }]);
    expect(snap.note).toBe(MKOE_QUIET_NOTE);
    expect('sourceUpdatedAt' in snap).toBe(false);
  });

  it('a day with outages that skips the saved queue is all on, with no quiet note (Review Focus 6)', async () => {
    const { p } = setup({ http: withSynthetic() });
    const snap = await p.fetchSnapshot({ ...MARIUPOLSKA, lineIndex: 2, groupId: '5.2' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }, { date: '2026-10-21', slots: fill('on') }]);
    expect('note' in snap).toBe(false);
    expect(snap.sourceUpdatedAt).toBe('22:40 19.10.2026');
  });

  it('[] with broken dictionaries is unreadable, never a quiet day', async () => {
    const ts = JSON.parse(TIME_SERIES);
    const queues = JSON.parse(QUEUES);
    for (const over of [
      { '/api/schedule/time-series': () => ok(JSON.stringify(ts.slice(0, 47))) },
      { '/api/outage-queue/by-type/3': () => ok(JSON.stringify(queues.filter((q: any) => q.name !== '6.2'))) },
      { '/api/schedule/time-series': () => ok('<html>404</html>') },
      { '/api/outage-queue/by-type/3': () => ok('[]') },
    ] as Record<string, Route>[]) {
      const { p } = setup({ http: fakeHttp(over) });
      await expectError(p.fetchSnapshot(MARIUPOLSKA), ProviderError, UNREADABLE);
    }
  });

  it('a rejected active throws; so do {} and an HTML page, and the cause carries no body', async () => {
    const rejected = setup({ http: fakeHttp({ '/api/v2/schedule/active': () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(MARIUPOLSKA), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ '/api/v2/schedule/active': () => failStatus(500) }) });
    await expectError(server.p.fetchSnapshot(MARIUPOLSKA), ProviderError, HTTP_ERROR);
    const object = setup({ http: fakeHttp({ '/api/v2/schedule/active': () => ok('{}') }) });
    await expectError(object.p.fetchSnapshot(MARIUPOLSKA), ProviderError, UNREADABLE);
    const html = setup({ http: fakeHttp({ '/api/v2/schedule/active': () => ok('<html>Whoops, looks like something went wrong.</html>') }) });
    const err = await expectError(html.p.fetchSnapshot(MARIUPOLSKA), ProviderError, UNREADABLE);
    expect(JSON.stringify(err.cause)).not.toContain('Whoops');
    expect(logged(html.log)).not.toContain('Whoops');
  });

  it('an unknown series type anywhere in active is unreadable (Review Focus 6)', async () => {
    const active = JSON.parse(SYNTHETIC);
    active[1].series[0].type = 'MAYBE';
    const { p } = setup({ http: fakeHttp({ '/api/v2/schedule/active': () => ok(JSON.stringify(active)) }) });
    const err = await expectError(p.fetchSnapshot(MARIUPOLSKA), ProviderError, UNREADABLE);
    expect(err.cause).toEqual({ what: 'schedule', reason: expect.any(String) });
    expect(JSON.stringify(err.cause)).not.toContain('MAYBE');
  });

  it('the none line requests neither active nor time-series nor the queue list', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot(SHEVCHENKA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.lines).toEqual(NONE_LINE);
    expect(snap.groupLabel).toBe('Не входить до ГПВ');
    expect('note' in snap).toBe(false);
    expect(http.schedule()).toHaveLength(0);
    expect(http.to('addr/dom/124212/outage-queue')).toHaveLength(1);
  });

  it('a house answer of an unknown shape gives today unknown, never the none line\'s all on (R11)', async () => {
    for (const [, body] of ODD_HOUSES) {
      const none = setup({ http: withSynthetic({ '/api/addr/dom/124212/outage-queue': () => ok(body) }) });
      const a = await none.p.fetchSnapshot(SHEVCHENKA_1);
      expect(a.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
      // Only the queues it can read: never the always-on line it cannot prove.
      expect(a.lines).toEqual([]);
      expect('note' in a).toBe(false);
      expect(none.http.schedule()).toHaveLength(0);
      const queue = setup({ http: withSynthetic({ '/api/addr/dom/115392/outage-queue': () => ok(body) }) });
      const b = await queue.p.fetchSnapshot(MARIUPOLSKA);
      expect(b.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
      expect('note' in b).toBe(false);
      expect(queue.http.schedule()).toHaveLength(0);
    }
    // Next to a known queue, the known one stays in lines and today is still unknown.
    const mixed = queueRows(queueRow(17, '2.2', 3), queueRow(40, '7', 3));
    const { p, log } = setup({ http: withSynthetic({ '/api/addr/dom/115392/outage-queue': () => ok(mixed) }) });
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: '2.2', label: 'Черга 2.2' }]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^mkoe fetchSnapshot: /), { what: 'outage-queue', reason: 'queue name' });
  });

  it('a moved queue gives today unknown and the house\'s new lines, without reading the schedule', async () => {
    const { p, http } = setup({ http: withSynthetic() });
    const snap = await p.fetchSnapshot({ ...MARIUPOLSKA, groupId: '3.1' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
    expect(snap.lines).toEqual(LINES_115392);
    expect(snap.groupLabel).toBe('Черга 3.1');
    expect('note' in snap).toBe(false);
    expect(http.schedule()).toHaveLength(0);
    // A house saved as none that joined a queue, and a queue house now out of the schedule, are moved lines too.
    const joined = await setup().p.fetchSnapshot({ ...MARIUPOLSKA, groupId: 'none' });
    expect(joined.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
    const left = await setup().p.fetchSnapshot({ ...SHEVCHENKA_1, groupId: '2.2' });
    expect(left.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
    expect(left.lines).toEqual(NONE_LINE);
  });
});

describe('MkoeProvider.fetchSnapshot address check', () => {
  it('a house missing from the house list is not found, without reading the schedule', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...MARIUPOLSKA, house: '999' }), AddressNotFoundError, NOT_FOUND);
    expect(http.schedule()).toHaveLength(0);
    // An empty list (the API's answer for a street id it no longer has) is the same.
    const gone = setup({ http: fakeHttp({ '/api/addr/street/2967/dom': () => ok('[]') }) });
    await expectError(gone.p.fetchSnapshot(MARIUPOLSKA), AddressNotFoundError, NOT_FOUND);
  });

  it('a city or street label that no longer resolves is not found', async () => {
    const { p } = setup();
    await expectError(p.fetchSnapshot({ ...MARIUPOLSKA, city: 'Неіснуюче' }), AddressNotFoundError, NOT_FOUND);
    await expectError(p.fetchSnapshot({ ...MARIUPOLSKA, street: 'вул. Неіснуюча' }), AddressNotFoundError, NOT_FOUND);
    await expectError(p.fetchSnapshot({ ...MARIUPOLSKA, city: 'Костянтинівка' }), AddressNotFoundError, NOT_FOUND);
  });

  it('a rejected outage-queue still delivers the schedule with the saved line and no current outage (R2)', async () => {
    const http = withSynthetic({ '/api/addr/dom/115392/outage-queue': () => new Error('ECONNRESET') });
    const { p, log } = setup({ http });
    const snap = await p.fetchSnapshot({ ...MARIUPOLSKA, lineIndex: 2 });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_2_2 }, { date: '2026-10-21', slots: OCT21_2_2 }]);
    expect(snap.lines).toEqual([{ index: 2, groupId: '2.2', label: 'Черга 2.2' }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^mkoe fetchSnapshot: /), expect.any(ProviderError));
  });

  it('a rejected or unreadable street list, house list or outage-queue is soft too, and the log carries no body', async () => {
    for (const over of [
      { '/api/addr/ns/171/street': () => failStatus(503) },
      { '/api/addr/ns/171/street': () => ok('<html>Server Error вул. Маріупольська</html>') },
      { '/api/addr/street/2967/dom': () => new Error('ECONNRESET') },
      { '/api/addr/street/2967/dom': () => ok('{"iddom":115392}') },
      { '/api/addr/dom/115392/outage-queue': () => ok('<html>Server Error</html>') },
      { '/api/addr/dom/115392/outage-queue': () => ok('[{"outage":null}]') },
      { '/api/addr/dom/115392/outage-queue': () => ok(JSON.stringify([patched(queueRow(17, '2.2', 3), { deleted: null })])) },
    ] as Record<string, Route>[]) {
      const { p, log } = setup({ http: withSynthetic(over) });
      const snap = await p.fetchSnapshot(MARIUPOLSKA);
      expect(snap.days[0]).toEqual({ date: '2026-10-20', slots: OCT20_2_2 });
      expect(snap.lines).toEqual([{ index: 1, groupId: '2.2', label: 'Черга 2.2' }]);
      expect('currentOutage' in snap).toBe(false);
      expect(log.warn).toHaveBeenCalled();
      expect(logged(log)).not.toContain('Server Error');
    }
  });

  it('a soft address failure does not hide a broken schedule', async () => {
    const http = fakeHttp({ '/api/addr/street/2967/dom': () => new Error('ECONNRESET'), '/api/v2/schedule/active': () => ok('{}') });
    const { p } = setup({ http });
    await expectError(p.fetchSnapshot(MARIUPOLSKA), ProviderError, UNREADABLE);
  });

  it('the house list is asked again on every refresh, not taken from the wizard\'s cache', async () => {
    const { p, http } = setup();
    await p.listHouses(CITY, 'вул. Маріупольська');
    await p.fetchSnapshot(MARIUPOLSKA);
    await p.fetchSnapshot(MARIUPOLSKA);
    expect(http.to('addr/street/2967/dom')).toHaveLength(3);
    expect(http.to('addr/ns/171/street')).toHaveLength(1);
  });

  it('a none line whose street or house list fails fails the snapshot: no schedule backs it (R7)', async () => {
    for (const [path, route, message] of [
      ['/api/addr/street/2968/dom', () => failStatus(500), HTTP_ERROR],
      ['/api/addr/street/2968/dom', () => new Error('ECONNRESET'), NO_ANSWER],
      ['/api/addr/street/2968/dom', () => ok('<html>Server Error</html>'), UNREADABLE],
      ['/api/addr/ns/171/street', () => failStatus(429), NO_ANSWER],
      ['/api/addr/ns/171/street', () => ok('{}'), UNREADABLE],
    ] as const) {
      const { p, http } = setup({ http: fakeHttp({ [path]: route }) });
      await expectError(p.fetchSnapshot(SHEVCHENKA_1), ProviderError, message);
      expect(http.schedule()).toHaveLength(0);
    }
  });

  it('offline, a none line fails with NetworkError, also on a later refresh (R7)', async () => {
    let offline = false;
    const http = fakeHttp({
      '/api/addr/street/2968/dom': () => (offline ? new Error('ERR_INTERNET_DISCONNECTED') : ok(HOUSES_2968)),
      '/api/addr/dom/124212/outage-queue': () => (offline ? new Error('ERR_INTERNET_DISCONNECTED') : ok(OUTAGE_QUEUES[124212])),
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const p = new MkoeProvider({ fetch: http.fetch, isOnline: () => !offline, log, now: () => at('2026-10-20', 12) });
    expect((await p.fetchSnapshot(SHEVCHENKA_1)).days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    offline = true;
    await expectError(p.fetchSnapshot(SHEVCHENKA_1), NetworkError, OFFLINE);
  });

  it('a none line whose outage-queue fails stays on with the saved line and no current outage (R7)', async () => {
    for (const route of [() => new Error('ECONNRESET'), () => ok('<html>Server Error</html>')]) {
      const { p, http, log } = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': route }) });
      const snap = await p.fetchSnapshot(SHEVCHENKA_1);
      expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
      expect(snap.lines).toEqual(NONE_LINE);
      expect('currentOutage' in snap).toBe(false);
      expect(http.schedule()).toHaveLength(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^mkoe fetchSnapshot: /), expect.anything());
      expect(logged(log)).not.toContain('Server Error');
    }
  });

  it('offline, a queue line keeps the soft check and fails on the schedule', async () => {
    const http = fakeHttp({
      '/api/addr/street/2967/dom': () => new Error('ERR_INTERNET_DISCONNECTED'),
      '/api/v2/schedule/active': () => new Error('ERR_INTERNET_DISCONNECTED'),
    });
    const { p, log } = setup({ http, online: false });
    await expectError(p.fetchSnapshot(MARIUPOLSKA), NetworkError, OFFLINE);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^mkoe fetchSnapshot: /), expect.any(NetworkError));
  });
});

describe('MkoeProvider current outage', () => {
  it('a ГАВ queue with enabled 1 is an emergency naming it, with no times and no groups', async () => {
    const { p } = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(dom115392Enabled(36)) }) });
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect(snap.currentOutage).toEqual({ kind: 'emergency', text: 'Знеструмлення за ГАВ 8(Р)' });
    expect(snap.lines).toEqual(LINES_115392);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
  });

  it('a СГАВ queue with enabled 1 names СГАВ', async () => {
    const { p } = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(dom115392Enabled(12)) }) });
    expect((await p.fetchSnapshot(MARIUPOLSKA)).currentOutage).toEqual({ kind: 'emergency', text: 'Знеструмлення за СГАВ 2' });
  });

  it('ГАВ wins over СГАВ when both are on, whatever the order', async () => {
    const both = JSON.parse(dom115392Enabled(12, 36));
    for (const rows of [both, [...both].reverse()]) {
      const { p } = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(JSON.stringify(rows)) }) });
      expect((await p.fetchSnapshot(MARIUPOLSKA)).currentOutage?.text).toBe('Знеструмлення за ГАВ 8(Р)');
    }
  });

  it('a switched-on ГПВ queue is not a current outage (the schedule shows it), nor is an enabled other than 1', async () => {
    const gpv = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(dom115392Enabled(17, 25)) }) });
    expect('currentOutage' in await gpv.p.fetchSnapshot(MARIUPOLSKA)).toBe(false);
    const rows = JSON.parse(DOM_115392).map((r: any) => (r.outage.type_id === 1 ? { ...r, outage: { ...r.outage, enabled: true } } : r));
    const odd = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(JSON.stringify(rows)) }) });
    expect('currentOutage' in await odd.p.fetchSnapshot(MARIUPOLSKA)).toBe(false);
  });

  it('a deleted ГАВ queue is not a current outage, even switched on', async () => {
    const rows = queueRows(queueRow(17, '2.2', 3), patched(queueRow(36, '8(Р)', 1, 1), { deleted: 1 }));
    const { p } = setup({ http: fakeHttp({ '/api/addr/dom/115392/outage-queue': () => ok(rows) }) });
    const snap = await p.fetchSnapshot(MARIUPOLSKA);
    expect('currentOutage' in snap).toBe(false);
    expect(snap.lines).toEqual([{ index: 1, groupId: '2.2', label: 'Черга 2.2' }]);
  });

  it('applies to a house out of the schedule too', async () => {
    const enabled = queueRows(queueRow(12, '2', 2), queueRow(33, '5(Р)', 1, 1));
    const { p } = setup({ http: fakeHttp({ '/api/addr/dom/124212/outage-queue': () => ok(enabled) }) });
    const snap = await p.fetchSnapshot(SHEVCHENKA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.currentOutage).toEqual({ kind: 'emergency', text: 'Знеструмлення за ГАВ 5(Р)' });
  });
});

describe('MkoeProvider requests', () => {
  it('every request is a GET for JSON with a timeout, to off.energy.mk.ua/api', async () => {
    const { p, http } = setup({ http: withSynthetic() });
    await p.listHouses(CITY, 'вул. Шевченка');
    await p.houseLines(CITY, 'вул. Шевченка', '1');
    await p.fetchSnapshot(MARIUPOLSKA);
    expect(http.calls.length).toBeGreaterThan(6);
    for (const c of http.calls) {
      expect(c.url.startsWith(`${API}/`)).toBe(true);
      expect(c.init.method).toBe('GET');
      expect(c.init.headers).toEqual({ Accept: 'application/json' });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
