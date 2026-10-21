// Every ztoe.com.ua page here is a real answer kept as windows-1251 bytes: the 20.10 GET, the 13.10 two-day and 26.04
// quiet pages (Wayback Machine), the two live POSTs of 21.10 for с. Березівка and the real вул. Київська result rows.
// Житомир's street select is made in the test (encoded to windows-1251). The inneti answers are real: pw_cities for
// Березівка (otg 5) was captured on 21.10, when cities 1636 and 17707 had no streets (as the router answers them).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZtoeProvider } from '../../src/main/providers/ztoe';
import { decodeCp1251, parseZtoeSchedule } from '../../src/main/providers/ztoe/page';
import { ztoeSettlements } from '../../src/main/providers/ztoe/settlements';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const DIR = join(__dirname, '..', 'fixtures', 'ztoe');
const raw = (n: string): Buffer => readFileSync(join(DIR, n));
const utf8 = (n: string): string => readFileSync(join(DIR, n), 'utf8');

const LIVE = raw('unhooking-search-2026-10-20-1728-live-cp1251.html');
const TWO_DAYS = raw('unhooking-search-2026-10-13-two-days-wayback-cp1251.html');
const QUIET = raw('unhooking-search-2026-04-26-quiet-day-wayback-cp1251.html');
const BEREZIVKA_STREETS = raw('post-rem5-ns16205-cp1251.html');
const VYSHNEVA_ROWS = raw('post-rem5-ns16205-st168893-all-cp1251.html');
const KYIVSKA_ROWS = raw('address-result-zhytomyr-kyivska-all-cp1251.html');
const KYIVSKA_FIRST10 = raw('address-result-zhytomyr-kyivska-first10-cp1251.html');
const OTGS = utf8('inneti-pw_otgs.json');
const CITIES_BEREZIVKA = utf8('inneti-pw_cities-otg5-Березівка.json');
const STREETS_2622 = utf8('inneti-pw_streets-city2622.json');
const ACCIDENTS_2622 = utf8('inneti-pw_accidents-city2622-berezivka.json');
const PLANNED = utf8('inneti-pw_accident_planeds-first5.json');

const SITE = 'https://www.ztoe.com.ua/unhooking-search.php';
const API = 'https://api-ztoe-poweron.inneti.net/api';
const NAME = 'Житомиробленерго';
const UNREADABLE = `Не вдалося прочитати графік ${NAME}`;
const NO_ANSWER = `Сайт ${NAME} не відповідає`;
const HTTP_ERROR = `Сайт ${NAME} повернув помилку`;
const OFFLINE = `Немає з’єднання з сайтом ${NAME}`;
const NOT_FOUND = `Адресу не знайдено у ${NAME} — оберіть її в налаштуваннях заново`;

/** windows-1251 bytes of a text, from the decoder's own table; a character outside it throws. */
const decoder = new TextDecoder('windows-1251');
const CP1251 = new Map(Array.from({ length: 256 }, (_, b) => [decoder.decode(Uint8Array.of(b)), b] as const));
const cp1251 = (s: string): Buffer => Buffer.from([...s].map((ch) => {
  const b = CP1251.get(ch);
  if (b === undefined) throw new Error(`not in windows-1251: ${ch}`);
  return b;
}));
const arrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Житомир's streets made up for the inneti join (ids from 900001); «вул. Шкільна» twice, so the second is labelled « (2)». */
const JOIN_STREETS: [number, string][] = [
  [176294, '1 пров. Андріївський'], [900001, 'вул. Івана Франка'], [900002, 'вул. Франка'],
  [900003, 'вул. Шкільна'], [900004, 'вул. Шкільна'],
];
/** Житомир's street select (rem 7, naspunkt 16657), made in the page's markup. */
const ZHYTOMYR_STREETS = cp1251('<form><select name="vulica_id" onchange="this.form.submit()">'
  + '<option value="0">Оберіть вулицю або провулок</option><option value="173934">вул. Київська</option>'
  + '<option value="174376">шосе Київське</option>'
  + JOIN_STREETS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('') + '</select></form>');
/** A result page of one household row: these houses on this queue cell and sub-queue cell. */
const rowsPage = (houses: string, queue: string, sub: string): Buffer => cp1251(
  `<b>За Вашим запитом знайдено записів: 1</b><table><tr><td>Житомирський</td><td>місто Житомир</td><td>вул.</td>`
  + `<td>${houses}</td><td>${queue}</td><td>${sub}</td><td>побутові споживачі</td></tr></table>`,
);
/** A result page of one row on a queue cell we do not know. */
const ODD_QUEUE_ROWS = rowsPage('1, 2', '5а', '1');

type Init = Parameters<HttpFetch>[1];
type Route = (q: URLSearchParams) => HttpResponse | Error;

/** A ztoe.com.ua page as served, in windows-1251: reading it as text is the bug this guards against. */
const page = (b: Buffer): HttpResponse => ({
  ok: true, status: 200,
  text: async () => { throw new Error('a windows-1251 page read as text'); },
  arrayBuffer: async () => arrayBuffer(b),
});
const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});
const hydra = (members: unknown[]) => JSON.stringify({ '@type': 'hydra:Collection', 'hydra:member': members, 'hydra:totalItems': members.length });
const EMPTY = hydra([]);

const BEREZIVKA_FORM = 'rem_id=5&naspunkt_id=16205';
const VYSHNEVA_FORM = `${BEREZIVKA_FORM}&vulica_id=168893&all=1`;
const ZHYTOMYR_FORM = 'rem_id=7&naspunkt_id=16657';
const KYIVSKA_FORM = `${ZHYTOMYR_FORM}&vulica_id=173934&all=1`;
const GET_SITE = 'GET /unhooking-search.php';

/**
 * Routes by method, path and form body: `GET /unhooking-search.php`, `POST <form body>` (the same page) and
 * `GET /api/<list>` (inneti). An inneti list of another city or street is empty; any other request rejects.
 */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    [GET_SITE]: () => page(LIVE),
    [`POST ${BEREZIVKA_FORM}`]: () => page(BEREZIVKA_STREETS),
    [`POST ${VYSHNEVA_FORM}`]: () => page(VYSHNEVA_ROWS),
    [`POST ${ZHYTOMYR_FORM}`]: () => page(ZHYTOMYR_STREETS),
    [`POST ${KYIVSKA_FORM}`]: () => page(KYIVSKA_ROWS),
    ...Object.fromEntries(JOIN_STREETS.map(([id]) => [`POST ${ZHYTOMYR_FORM}&vulica_id=${id}&all=1`, () => page(rowsPage('1, 2', '3', '1'))])),
    'GET /api/pw_otgs': () => ok(OTGS),
    'GET /api/pw_cities': (q) => ok(q.get('otg.id') === '5' && q.get('name') === 'Березівка' ? CITIES_BEREZIVKA : EMPTY),
    'GET /api/pw_streets': (q) => ok(q.get('city.id') === '2622' ? STREETS_2622 : EMPTY),
    'GET /api/pw_accidents': (q) => ok(q.get('city.id') === '2622' ? ACCIDENTS_2622 : EMPTY),
    'GET /api/pw_accident_planeds': () => ok(PLANNED),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    let key: string | undefined;
    if (url === SITE) key = init.method === 'POST' ? `POST ${init.body}` : GET_SITE;
    else if (u.origin === new URL(API).origin && init.method === 'GET') key = `GET ${u.pathname}`;
    const route = key === undefined ? undefined : routes[key];
    if (!route) throw new Error(`unexpected request ${init.method} ${url} ${init.body ?? ''}`);
    const r = route(u.searchParams);
    if (r instanceof Error) throw r;
    return r;
  });
  const site = () => calls.filter((c) => c.url === SITE && c.init.method === 'GET');
  const posts = () => calls.filter((c) => c.init.method === 'POST').map((c) => c.init.body);
  const to = (list: string) => calls.filter((c) => c.url.startsWith(`${API}/${list}?`));
  return { fetch, calls, site, posts, to };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

/** The provider with a pinned `now`, and a fake clock that the fake sleep moves on: the 1 s spacing costs no time. */
function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: Date; online?: boolean } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let t = 0;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const now = opts.now ?? at('2026-10-20', 12);
  const p = new ZtoeProvider({ fetch: http.fetch, isOnline: () => opts.online ?? true, log, now: () => now, sleep, clock: () => t });
  return { p, http, log, sleep };
}

async function expectError(p: Promise<unknown>, cls: typeof ProviderError, message: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
  return err as Error;
}

/** The log calls as text, errors with their message and cause: what a log line could carry. */
const logged = (log: ReturnType<typeof setup>['log']) => JSON.stringify(
  [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls],
  (_k, v: unknown) => (v instanceof Error ? { m: v.message, c: v.cause } : v),
);

/** с. Березівка of the Хорошівський РЕМ (naspunkt 16205): four namesakes elsewhere, so its label carries the РЕМ. */
const BEREZIVKA = ztoeSettlements().find((s) => s.id === 16205)!.label;
const ZHYTOMYR = 'місто Житомир';
const VYSHNEVA_1: Address = { providerId: 'ztoe', city: BEREZIVKA, street: 'вул. Вишнева', house: '1', lineIndex: 1, groupId: '5.1' };
const kyivska = (house: string, groupId = 'none'): Address => ({
  providerId: 'ztoe', city: ZHYTOMYR, street: 'вул. Київська', house, lineIndex: 1, groupId,
});
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const LINE_5_1 = [{ index: 1, groupId: '5.1', label: 'Черга 5.1' }];
const NONE_LINE = [{ index: 1, groupId: 'none', label: 'Не входить до ГПВ' }];

const pageOf = (b: Buffer) => parseZtoeSchedule(decodeCp1251(arrayBuffer(b)));
const OCT20 = pageOf(LIVE);
const OCT20_5_1 = OCT20.days.get('2026-10-20')!['5.1'];
const OCT13 = pageOf(TWO_DAYS);

/** The Березівка accident rows with each row's switchSubReason set to this value. */
const accidentsWith = (subReason: unknown) => {
  const body = JSON.parse(ACCIDENTS_2622);
  for (const m of body['hydra:member']) m.switchSubReason = subReason;
  return JSON.stringify(body);
};
const EMERGENCY_11_17 = { kind: 'emergency', text: 'Аварійне відключення', start: '11:15 20.10.2026', end: '17:00 20.10.2026' };
const EMERGENCY_10_16 = { kind: 'emergency', text: 'Аварійне відключення', start: '10:00 20.10.2026', end: '16:00 20.10.2026' };

/**
 * Житомир in inneti (otg 6) as hand-built Hydra lists: city 333 with these streets, and on each street of `outage` an
 * emergency 10:00-16:00 on 20.10 for houses 1 and 72.
 */
function zhytomyrInneti(streets: [number, string][], outage: number[], over: Record<string, Route> = {}) {
  return fakeHttp({
    'GET /api/pw_cities': (q) => ok(q.get('otg.id') === '6' && q.get('name') === 'Житомир' ? hydra([{ id: 333, name: 'Житомир' }]) : EMPTY),
    'GET /api/pw_streets': (q) => ok(q.get('city.id') === '333' ? hydra(streets.map(([id, name]) => ({ id, name }))) : EMPTY),
    'GET /api/pw_accidents': (q) => {
      const street = Number(q.get('street.id'));
      return ok(q.get('city.id') === '333' && outage.includes(street) ? hydra([{
        city: { id: 333 }, street: { id: street }, switchSubReason: 0, buildingNames: '1, 72',
        dateEvent: '2026-10-20T10:00:00+00:00', datePlanIn: '2026-10-20T16:00:00+00:00',
      }]) : EMPTY);
    },
    ...over,
  });
}

describe('ZtoeProvider address lookup', () => {
  it('listCities is the bundled list and makes no request', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toEqual(ztoeSettlements().map((s) => s.label));
    expect(cities).toContain(ZHYTOMYR);
    expect(BEREZIVKA).toBe('с. Березівка (Хорошівський РЕМ)');
    expect(cities).toContain(BEREZIVKA);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('listStreets POSTs the settlement\'s rem_id and naspunkt_id and sorts the names', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets(BEREZIVKA);
    expect(http.calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([[SITE, 'POST', 'rem_id=5&naspunkt_id=16205']]);
    expect(streets).toEqual(['вул. Вишнева', 'вул. Садова', 'вул. Центральна', 'КТП-2']);
    expect(streets).toEqual([...streets].sort((a, b) => a.localeCompare(b, 'uk')));
  });

  it('keeps the street list for the run', async () => {
    const { p, http } = setup();
    await p.listStreets(BEREZIVKA);
    await p.listStreets(BEREZIVKA);
    await p.listHouses(BEREZIVKA, 'вул. Вишнева');
    expect(http.posts()).toEqual([BEREZIVKA_FORM, VYSHNEVA_FORM]);
  });

  it('an unknown settlement label, or a bare name four РЕМ share, is not found, with no request', async () => {
    const { p, http } = setup();
    await expectError(p.listStreets('Неіснуюче'), AddressNotFoundError, NOT_FOUND);
    await expectError(p.listStreets('с. Березівка'), AddressNotFoundError, NOT_FOUND);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('listHouses POSTs with all=1 and gives each house with its lines; the second call makes no request', async () => {
    const { p, http } = setup();
    const houses = await p.listHouses(BEREZIVKA, 'вул. Вишнева');
    expect(http.posts()).toEqual([BEREZIVKA_FORM, VYSHNEVA_FORM]);
    expect(houses.find((h) => h.house === '1')).toEqual({ house: '1', lines: LINE_5_1, outageActive: false });
    // House 18 has only a legal-entity row.
    expect(houses.find((h) => h.house === '18')?.lines).toEqual(LINE_5_1);
    expect(houses.some((h) => h.linesPending)).toBe(false);
    expect(await p.listHouses(BEREZIVKA, 'вул. Вишнева')).toEqual(houses);
    expect(http.posts()).toHaveLength(2);
  });

  it('an unknown street label is not found', async () => {
    const { p } = setup();
    await expectError(p.listHouses(BEREZIVKA, 'вул. Неіснуюча'), AddressNotFoundError, NOT_FOUND);
  });

  it('an odd street page or row page is unreadable, and the error carries no body', async () => {
    for (const [form, body, call] of [
      [BEREZIVKA_FORM, cp1251('<html>Помилка вул. Вишнева</html>'), (p: ZtoeProvider) => p.listStreets(BEREZIVKA)],
      [VYSHNEVA_FORM, KYIVSKA_FIRST10, (p: ZtoeProvider) => p.listHouses(BEREZIVKA, 'вул. Вишнева')],
      [VYSHNEVA_FORM, ODD_QUEUE_ROWS, (p: ZtoeProvider) => p.listHouses(BEREZIVKA, 'вул. Вишнева')],
    ] as const) {
      const { p, log } = setup({ http: fakeHttp({ [`POST ${form}`]: () => page(body) }) });
      const err = await expectError(call(p), ProviderError, UNREADABLE);
      expect(JSON.stringify(err.cause)).not.toMatch(/Помилка|Вишнева|5а/);
      expect(logged(log)).not.toMatch(/Помилка|Вишнева|5а/);
    }
  });

  it('a request failing in the wizard is that error', async () => {
    const rejected = setup({ http: fakeHttp({ [`POST ${BEREZIVKA_FORM}`]: () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.listStreets(BEREZIVKA), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ [`POST ${VYSHNEVA_FORM}`]: () => failStatus(500) }) });
    await expectError(server.p.listHouses(BEREZIVKA, 'вул. Вишнева'), ProviderError, HTTP_ERROR);
  });
});

describe('ZtoeProvider schedule', () => {
  it('reads the 20.10 page for Березівка, вул. Вишнева 1 on 5.1', async () => {
    const { p, http, log } = setup();
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(OCT20_5_1).toContain('off');
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_5_1 }]);
    expect(snap.sourceUpdatedAt).toBe('17:00 20.10.2026');
    expect(snap.note).toBe(OCT20.banner);
    expect(snap).toMatchObject({
      providerId: 'ztoe', address: VYSHNEVA_1, groupId: '5.1', groupLabel: 'Черга 5.1', fetchedAt: at('2026-10-20', 12).toISOString(),
    });
    expect(snap.lines).toEqual(LINE_5_1);
    expect(http.site()).toHaveLength(1);
    expect(http.posts()).toEqual([BEREZIVKA_FORM, VYSHNEVA_FORM]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads the page as windows-1251 bytes: the banner is readable Cyrillic', async () => {
    // The router's text() throws for every ztoe.com.ua page: only the bytes can be read.
    const snap = await setup().p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.note).toMatch(/^На 12:30 20\.10\.2026р\. НЕК "Укренерго" змінив застосування кількості черг/);
  });

  it('just after midnight, with only yesterday\'s table on the page, the snapshot is unreadable (Review Focus 1)', async () => {
    const { p, http } = setup({ now: at('2026-10-21', 0, 10) });
    const err = await expectError(p.fetchSnapshot(VYSHNEVA_1), ProviderError, UNREADABLE);
    expect(err.cause).toEqual({ what: 'schedule', reason: 'no table for today' });
    expect(http.site()).toHaveLength(1);
  });

  it('adds tomorrow when its table is there', async () => {
    const http = fakeHttp({ [GET_SITE]: () => page(TWO_DAYS) });
    const { p } = setup({ http, now: at('2026-10-13', 23) });
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.days).toEqual([
      { date: '2026-10-13', slots: OCT13.days.get('2026-10-13')!['5.1'] },
      { date: '2026-10-14', slots: OCT13.days.get('2026-10-14')!['5.1'] },
    ]);
    expect(snap.sourceUpdatedAt).toBe('22:30 13.10.2026');
  });

  it('an all-white day is plain on, with the operator\'s banner and no quiet note of ours', async () => {
    const http = fakeHttp({ [GET_SITE]: () => page(QUIET) });
    const { p } = setup({ http, now: at('2026-04-26', 12) });
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.days).toEqual([{ date: '2026-04-26', slots: fill('on') }]);
    expect(snap.note).toBe(pageOf(QUIET).banner);
    expect(snap.note).toContain('не надходило');
    expect(snap.note).not.toContain('не опублікувало');
  });

  it('a page of another shape is unreadable, a failed GET is that error, and no error carries the body', async () => {
    const odd = setup({ http: fakeHttp({ [GET_SITE]: () => page(cp1251('<html>Технічні роботи</html>')) }) });
    const err = await expectError(odd.p.fetchSnapshot(VYSHNEVA_1), ProviderError, UNREADABLE);
    expect(JSON.stringify(err.cause)).not.toContain('Технічні');
    expect(logged(odd.log)).not.toContain('Технічні');
    const rejected = setup({ http: fakeHttp({ [GET_SITE]: () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(VYSHNEVA_1), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ [GET_SITE]: () => failStatus(502) }) });
    await expectError(server.p.fetchSnapshot(VYSHNEVA_1), ProviderError, HTTP_ERROR);
  });

  it('the none line: Київська 72 is all on without reading the schedule', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot(kyivska('72'));
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.lines).toEqual(NONE_LINE);
    expect(snap.groupLabel).toBe('Не входить до ГПВ');
    expect('note' in snap).toBe(false);
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(http.site()).toHaveLength(0);
    expect(http.posts()).toEqual([ZHYTOMYR_FORM, KYIVSKA_FORM]);
  });

  it('a saved «91А» finds the row written «91-А» (Review Focus 4)', async () => {
    const { p, log } = setup();
    const snap = await p.fetchSnapshot(kyivska('91А'));
    expect(snap.lines).toEqual(NONE_LINE);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect((await p.fetchSnapshot(kyivska('91-а'))).lines).toEqual(NONE_LINE);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a moved queue: saved 3.1 where the rows say 5.1 gives today unknown and the house\'s lines', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...VYSHNEVA_1, groupId: '3.1' });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('unknown') }]);
    expect(snap.lines).toEqual(LINE_5_1);
    expect(snap.groupLabel).toBe('Черга 3.1');
    expect(http.site()).toHaveLength(0);
  });
});

describe('ZtoeProvider.fetchSnapshot address check', () => {
  it('a house gone from rows that read fine is not found, without reading the schedule', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...VYSHNEVA_1, house: '999' }), AddressNotFoundError, NOT_FOUND);
    expect(http.site()).toHaveLength(0);
  });

  it('a street gone from a street list that read fine, or a settlement gone from the bundle, is not found', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...VYSHNEVA_1, street: 'вул. Неіснуюча' }), AddressNotFoundError, NOT_FOUND);
    expect(http.posts()).toEqual([BEREZIVKA_FORM]);
    const gone = setup();
    await expectError(gone.p.fetchSnapshot({ ...VYSHNEVA_1, city: 'Неіснуюче' }), AddressNotFoundError, NOT_FOUND);
    expect(gone.http.fetch).not.toHaveBeenCalled();
  });

  it('a failed house check on a queue line keeps the saved line and logs one warn', async () => {
    for (const over of [
      { [`POST ${VYSHNEVA_FORM}`]: () => new Error('ECONNRESET') },
      { [`POST ${BEREZIVKA_FORM}`]: () => new Error('ECONNRESET') },
      { [`POST ${VYSHNEVA_FORM}`]: () => failStatus(500) },
      { [`POST ${VYSHNEVA_FORM}`]: () => page(KYIVSKA_FIRST10) },
    ] as Record<string, Route>[]) {
      const { p, log } = setup({ http: fakeHttp(over) });
      const snap = await p.fetchSnapshot({ ...VYSHNEVA_1, lineIndex: 2 });
      expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_5_1 }]);
      expect(snap.lines).toEqual([{ index: 2, groupId: '5.1', label: 'Черга 5.1' }]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('ztoe fetchSnapshot: address check failed, keeping the saved line', expect.any(ProviderError));
    }
  });

  it('a saved queue the page does not have is unreadable, never all on', async () => {
    const { p } = setup({ http: fakeHttp({ [`POST ${VYSHNEVA_FORM}`]: () => new Error('ECONNRESET') }) });
    const err = await expectError(p.fetchSnapshot({ ...VYSHNEVA_1, groupId: '7.1' }), ProviderError, UNREADABLE);
    expect(err.cause).toEqual({ what: 'schedule', reason: 'no such queue' });
  });

  it('a failed house check on the none line fails the snapshot (R7)', async () => {
    for (const [route, message] of [
      [() => new Error('ECONNRESET'), NO_ANSWER],
      [() => failStatus(500), HTTP_ERROR],
      [() => page(KYIVSKA_FIRST10), UNREADABLE],
    ] as const) {
      const { p, http } = setup({ http: fakeHttp({ [`POST ${KYIVSKA_FORM}`]: route }) });
      await expectError(p.fetchSnapshot(kyivska('72')), ProviderError, message);
      expect(http.site()).toHaveLength(0);
    }
    const offline = setup({ http: fakeHttp({ [`POST ${KYIVSKA_FORM}`]: () => new Error('ERR_INTERNET_DISCONNECTED') }), online: false });
    await expectError(offline.p.fetchSnapshot(kyivska('72')), NetworkError, OFFLINE);
  });

  it('the rows are asked again on every refresh, never taken from the wizard\'s list', async () => {
    const { p, http } = setup();
    await p.listHouses(BEREZIVKA, 'вул. Вишнева');
    await p.fetchSnapshot(VYSHNEVA_1);
    await p.fetchSnapshot(VYSHNEVA_1);
    expect(http.posts()).toEqual([BEREZIVKA_FORM, VYSHNEVA_FORM, VYSHNEVA_FORM, VYSHNEVA_FORM]);
  });
});

describe('ZtoeProvider current outage', () => {
  it('at 14:00 on 20.10 Вишнева 1 is in the emergency of 11:15-17:00; at 18:00 there is none', async () => {
    const { p, http } = setup({ now: at('2026-10-20', 14) });
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.currentOutage).toEqual(EMERGENCY_11_17);
    expect(http.to('pw_otgs').map((c) => c.url)).toEqual([`${API}/pw_otgs?pagination=false`]);
    expect(http.to('pw_cities').map((c) => c.url))
      .toEqual([`${API}/pw_cities?pagination=false&otg.id=5&name=${encodeURIComponent('Березівка')}`]);
    expect(http.to('pw_streets').map((c) => c.url)).toEqual([1636, 2622, 17707].map((id) => `${API}/pw_streets?pagination=false&city.id=${id}`));
    expect(http.to('pw_accidents').map((c) => c.url)).toEqual([`${API}/pw_accidents?page=1&city.id=2622&street.id=72590`]);
    expect(http.to('pw_accident_planeds').map((c) => c.url)).toEqual([`${API}/pw_accident_planeds?page=1&city.id=2622&street.id=72590`]);

    const late = await setup({ now: at('2026-10-20', 18) }).p.fetchSnapshot(VYSHNEVA_1);
    expect('currentOutage' in late).toBe(false);
  });

  it('matches the house however it is written: a saved «1-а» is the listed «1А»', async () => {
    const { p } = setup({ now: at('2026-10-20', 14) });
    const snap = await p.fetchSnapshot({ ...VYSHNEVA_1, house: '1-а' });
    expect(snap.lines).toEqual(LINE_5_1);
    expect(snap.currentOutage).toEqual(EMERGENCY_11_17);
  });

  it('switchSubReason 1 is an outage for operational security; 2 repeats the schedule and is skipped', async () => {
    const reroute = (body: string) => fakeHttp({ 'GET /api/pw_accidents': () => ok(body) });
    const security = await setup({ http: reroute(accidentsWith(1)), now: at('2026-10-20', 14) }).p.fetchSnapshot(VYSHNEVA_1);
    expect(security.currentOutage).toEqual({ ...EMERGENCY_11_17, kind: 'other', text: 'Відключення за операційною безпекою' });
    const schedule = await setup({ http: reroute(accidentsWith(2)), now: at('2026-10-20', 14) }).p.fetchSnapshot(VYSHNEVA_1);
    expect('currentOutage' in schedule).toBe(false);
  });

  it('planned works running now are a planned outage', async () => {
    const planned = JSON.parse(PLANNED);
    Object.assign(planned['hydra:member'][0], { city: { id: 2622 }, street: { id: 72590 }, buildingNames: '1, 2' });
    const http = fakeHttp({ 'GET /api/pw_accidents': () => ok(EMPTY), 'GET /api/pw_accident_planeds': () => ok(JSON.stringify(planned)) });
    const snap = await setup({ http }).p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.currentOutage).toEqual({ kind: 'planned', text: 'Планові роботи', start: '08:00 20.10.2026', end: '17:00 20.10.2026' });
  });

  it('only a city of exactly that name counts, and a street in two of them is not one place', async () => {
    // The API's name filter also matches a part of a name («Березів» gives every Березівка).
    const cities = JSON.parse(CITIES_BEREZIVKA);
    cities['hydra:member'].push({ id: 900, name: 'Березівка Друга', otg: { name: 'Хорошівський РЕМ' } });
    const vyshneva = hydra([{ id: 901, name: 'вул. Вишнева' }]);
    const other = fakeHttp({
      'GET /api/pw_cities': () => ok(JSON.stringify(cities)),
      'GET /api/pw_streets': (q) => ok(q.get('city.id') === '2622' ? STREETS_2622 : q.get('city.id') === '900' ? vyshneva : EMPTY),
    });
    const found = setup({ http: other, now: at('2026-10-20', 14) });
    expect((await found.p.fetchSnapshot(VYSHNEVA_1)).currentOutage).toEqual(EMERGENCY_11_17);
    expect(found.http.to('pw_streets').map((c) => new URL(c.url).searchParams.get('city.id'))).toEqual(['1636', '2622', '17707']);

    const twice = fakeHttp({ 'GET /api/pw_streets': (q) => ok(q.get('city.id') === '2622' ? STREETS_2622 : q.get('city.id') === '1636' ? vyshneva : EMPTY) });
    const { p, http } = setup({ http: twice, now: at('2026-10-20', 14) });
    expect('currentOutage' in await p.fetchSnapshot(VYSHNEVA_1)).toBe(false);
    expect(http.to('pw_accidents')).toHaveLength(0);
  });

  it('the settlement is asked by its bare name in its РЕМ; a с/рада area is not asked at all', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(kyivska('72'));
    expect(http.to('pw_cities').map((c) => c.url))
      .toEqual([`${API}/pw_cities?pagination=false&otg.id=6&name=${encodeURIComponent('Житомир')}`]);
    expect(http.to('pw_accidents')).toHaveLength(0);

    // Every kind word the bundle writes, in either case. (Their street lists are not routed: the check fails softly.)
    for (const kind of ['с. ', 'Село ', 'селище ', 'Селище ', 'місто ', 'Місто ', 'м. ']) {
      const s = ztoeSettlements().find((x) => x.name.startsWith(kind))!;
      const other = setup();
      await other.p.fetchSnapshot({ ...VYSHNEVA_1, city: s.label });
      expect(other.http.to('pw_cities').map((c) => new URL(c.url).searchParams.get('name'))).toEqual([s.name.slice(kind.length)]);
    }

    const area = ztoeSettlements().find((s) => s.id === 16671)!;
    expect(area.name).toBe('с/рада Березівська');
    const council = setup();
    const snap = await council.p.fetchSnapshot({ ...VYSHNEVA_1, city: area.label });
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_5_1 }]);
    expect(council.http.calls.filter((c) => c.url.startsWith(API))).toHaveLength(0);
  });

  it('keeps the place for the run, a miss too, but not a failed lookup', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(VYSHNEVA_1);
    await p.fetchSnapshot(VYSHNEVA_1);
    await p.fetchSnapshot(kyivska('72'));
    await p.fetchSnapshot(kyivska('72'));
    expect(http.to('pw_otgs')).toHaveLength(1);
    expect(http.to('pw_cities')).toHaveLength(2);
    expect(http.to('pw_streets')).toHaveLength(3);
    expect(http.to('pw_accidents')).toHaveLength(2);

    let fail = true;
    const flaky = fakeHttp({ 'GET /api/pw_cities': () => (fail ? new Error('ECONNRESET') : ok(CITIES_BEREZIVKA)) });
    const again = setup({ http: flaky, now: at('2026-10-20', 14) });
    expect('currentOutage' in await again.p.fetchSnapshot(VYSHNEVA_1)).toBe(false);
    fail = false;
    expect((await again.p.fetchSnapshot(VYSHNEVA_1)).currentOutage).toEqual(EMERGENCY_11_17);
  });

  it('a rejected pw_accidents still delivers the schedule', async () => {
    const { p, log } = setup({ http: fakeHttp({ 'GET /api/pw_accidents': () => new Error('ECONNRESET') }), now: at('2026-10-20', 14) });
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_5_1 }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('ztoe fetchSnapshot: current outage lookup failed', expect.any(ProviderError));
  });

  it('an outage list of another shape still delivers the schedule, and the log carries no body', async () => {
    const { p, log } = setup({ http: fakeHttp({ 'GET /api/pw_accident_planeds': () => ok('{"error":"Пошкодження"}') }) });
    const snap = await p.fetchSnapshot(VYSHNEVA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: OCT20_5_1 }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(logged(log)).not.toContain('Пошкодження');
  });

  it('applies to a house out of the schedule too', async () => {
    const http = zhytomyrInneti([[2, 'вул. Київська']], [2]);
    const snap = await setup({ http }).p.fetchSnapshot(kyivska('72'));
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.currentOutage).toEqual(EMERGENCY_10_16);
  });
});

describe('ZtoeProvider current outage: the street joined by its words (R2)', () => {
  const onStreet = (street: string): Address => ({ providerId: 'ztoe', city: ZHYTOMYR, street, house: '1', lineIndex: 1, groupId: '3.1' });
  const accidentStreets = (http: ReturnType<typeof fakeHttp>) => http.to('pw_accidents').map((c) => new URL(c.url).searchParams.get('street.id'));

  it('a saved «1 пров. Андріївський» joins inneti\'s «1-й пров. Андріївський», not «2-й пров. Андріївський»', async () => {
    const http = zhytomyrInneti([[1, '1-й пров. Андріївський'], [2, '2-й пров. Андріївський']], [1, 2]);
    const { p, log } = setup({ http });
    expect((await p.fetchSnapshot(onStreet('1 пров. Андріївський'))).currentOutage).toEqual(EMERGENCY_10_16);
    expect(accidentStreets(http)).toEqual(['1']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('«вул. Івана Франка» joins «вул. Франка Івана»', async () => {
    const http = zhytomyrInneti([[3, 'вул. Франка Івана'], [4, 'пров. Франка']], [3]);
    expect((await setup({ http }).p.fetchSnapshot(onStreet('вул. Івана Франка'))).currentOutage).toEqual(EMERGENCY_10_16);
    expect(accidentStreets(http)).toEqual(['3']);
  });

  it('«вул. Франка» does not join «пров. Франка»', async () => {
    const http = zhytomyrInneti([[3, 'вул. Франка Івана'], [4, 'пров. Франка']], [3, 4]);
    expect('currentOutage' in await setup({ http }).p.fetchSnapshot(onStreet('вул. Франка'))).toBe(false);
    expect(http.to('pw_accidents')).toHaveLength(0);
  });

  it('two inneti spellings of one street in one city are both read, and the outage on the second is found', async () => {
    const http = zhytomyrInneti([[1, '1-й пров. Андріївський'], [5, 'пров. 1-й Андріївський']], [5]);
    expect((await setup({ http }).p.fetchSnapshot(onStreet('1 пров. Андріївський'))).currentOutage).toEqual(EMERGENCY_10_16);
    expect(accidentStreets(http)).toEqual(['1', '5']);
    expect(http.to('pw_accident_planeds').map((c) => new URL(c.url).searchParams.get('street.id'))).toEqual(['1', '5']);
  });

  it('a street labelled «вул. Шкільна (2)» joins by its record\'s name «вул. Шкільна»', async () => {
    const http = zhytomyrInneti([[6, 'вул. Шкільна']], [6]);
    const { p } = setup({ http });
    expect(await p.listStreets(ZHYTOMYR)).toContain('вул. Шкільна (2)');
    const snap = await p.fetchSnapshot(onStreet('вул. Шкільна (2)'));
    expect(snap.lines).toEqual([{ index: 1, groupId: '3.1', label: 'Черга 3.1' }]);
    expect(snap.currentOutage).toEqual(EMERGENCY_10_16);
    expect(http.posts()).toEqual([ZHYTOMYR_FORM, `${ZHYTOMYR_FORM}&vulica_id=900004&all=1`]);
  });

  it('without the street list the saved label is joined', async () => {
    const http = zhytomyrInneti([[1, '1-й пров. Андріївський']], [1], { [`POST ${ZHYTOMYR_FORM}`]: () => new Error('ECONNRESET') });
    const { p, log } = setup({ http });
    expect((await p.fetchSnapshot(onStreet('1 пров. Андріївський'))).currentOutage).toEqual(EMERGENCY_10_16);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('ZtoeProvider requests', () => {
  it('POSTs a form to the page, GETs the page plainly and asks inneti for ld+json, each with a timeout', async () => {
    const { p, http } = setup();
    await p.listHouses(BEREZIVKA, 'вул. Вишнева');
    await p.fetchSnapshot(VYSHNEVA_1);
    expect(http.calls.length).toBeGreaterThan(8);
    for (const c of http.calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      if (c.init.method === 'POST') {
        expect(c.url).toBe(SITE);
        expect(c.init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
      } else if (c.url === SITE) {
        expect(c.init.body).toBeUndefined();
      } else {
        expect(c.url.startsWith(`${API}/`)).toBe(true);
        expect(c.init.headers).toEqual({ Accept: 'application/ld+json' });
      }
    }
  });

  it('two requests start at least 1000 ms apart (fake clock and sleep)', async () => {
    const { p, sleep } = setup();
    await p.listStreets(BEREZIVKA);
    expect(sleep).not.toHaveBeenCalled();
    await p.listHouses(BEREZIVKA, 'вул. Вишнева');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
