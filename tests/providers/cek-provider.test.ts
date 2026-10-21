// The map page is the live page of 21.10.2026 cut to 8 streets of 3 cities; the form's answers are the saved ones:
// queue=all for 15.01.2026 (all 12 queues with outages), queue=1.1 for that day (only the 1.1 block) and the quiet
// answer of 20.10.2026. The router answers the form by the posted date.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CekProvider, CEK_QUIET_NOTE } from '../../src/main/providers/cek';
import { CEK_DTEK_NOTE, parseCekDay } from '../../src/main/providers/cek/parse';
import { AddressNotFoundError } from '../../src/main/providers/resolve';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const DIR = join(__dirname, '..', 'fixtures', 'cek');
const fx = (n: string): string => readFileSync(join(DIR, n), 'utf8');

const MAP_PAGE = fx('map-page.html');
const DAY = fx('cek-gpv-post-all-2026-01-15.html.txt');
const ONE = fx('cek-gpv-post-1.1-2026-01-15.html.txt');
const QUIET = fx('cek-gpv-post-all-2026-10-20-quiet.html.txt');

const BASE = 'https://cek.dp.ua';
const MAP_PATH = '/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html';
const FORM_PATH = '/index.php/cpojivaham/vidkliuchennia/2-uncategorised/921-grafik-pogodinikh-vidklyuchen.html';
const NAME = 'ЦЕК';
const UNREADABLE = `Не вдалося прочитати графік ${NAME}`;
const NO_ANSWER = `Сайт ${NAME} не відповідає`;
const HTTP_ERROR = `Сайт ${NAME} повернув помилку`;
const OFFLINE = `Немає з’єднання з сайтом ${NAME}`;
const NOT_FOUND = `Адресу не знайдено у ${NAME} — оберіть її в налаштуваннях заново`;

/** `s` with the first match of `from` replaced; a `from` that is not there is a broken test. */
function swap(s: string, from: string | RegExp, to: string): string {
  if (typeof from === 'string' ? !s.includes(from) : !from.test(s)) throw new Error(`nothing to replace: ${String(from)}`);
  return s.replace(from, to);
}

/** «Черга » as the page escapes it, for map values written into the served object. */
const CHERHA = '\\u0427\\u0435\\u0440\\u0433\\u0430 ';
/** The served entry of вул. Робоча « 162» (a key with a space before it). */
const ROBOCHA_162 = `" 162":"${CHERHA}3.2"`;

type Init = Parameters<HttpFetch>[1];
type Route = (form: URLSearchParams) => HttpResponse | Error;

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});

const MAP = `GET ${MAP_PATH}`;
const FORM = `POST ${FORM_PATH}`;

/**
 * Routes by method and path. The form answers each date from `days` (default: 15.01.2026 has its outages), any other
 * date quiet. Any other request rejects.
 */
function fakeHttp(over: Record<string, Route> = {}, days: Record<string, string> = { '2026-01-15': DAY }) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    [MAP]: () => ok(MAP_PAGE),
    [FORM]: (f) => ok(days[f.get('date') ?? ''] ?? QUIET),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const route = u.origin === BASE ? routes[`${init.method} ${u.pathname}${u.search}`] : undefined;
    if (!route) throw new Error(`unexpected request ${init.method} ${url}`);
    const r = route(new URLSearchParams(init.body ?? ''));
    if (r instanceof Error) throw r;
    return r;
  });
  const maps = () => calls.filter((c) => c.init.method === 'GET' && c.url === `${BASE}${MAP_PATH}`);
  const posts = () => calls.filter((c) => c.init.method === 'POST').map((c) => c.init.body);
  return { fetch, calls, maps, posts };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

/** The provider with a pinned `now`, and a fake clock that the fake sleep moves on: the 1 s spacing costs no time. */
function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: Date; online?: boolean } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let t = 0;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const now = opts.now ?? at('2026-01-15', 12);
  const p = new CekProvider({ fetch: http.fetch, isOnline: () => opts.online ?? true, log, now: () => now, sleep, clock: () => t });
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

const DNIPRO = 'м. Дніпро';
const address = (street: string, house: string, groupId: string, lineIndex = 1, city = DNIPRO): Address =>
  ({ providerId: 'cek', city, street, house, lineIndex, groupId });
const FILATOVA_1 = address('вул. Філатова', '1', '1.1');
const ROBOCHA_65 = address('вул. Робоча', '65', '3.2');
const line = (index: number, groupId: string) => ({ index, groupId, label: `Черга ${groupId}` });
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const DAY_SLOTS = parseCekDay(DAY)!;

describe('CekProvider address lookup', () => {
  it('listCities makes one map request, and a second call makes none', async () => {
    const { p, http } = setup();
    expect(await p.listCities()).toEqual(['м. Дніпро', 'м. Жовті Води', 'с. Петриківка']);
    expect(await p.listCities()).toEqual(['м. Дніпро', 'м. Жовті Води', 'с. Петриківка']);
    await p.listStreets(DNIPRO);
    await p.listHouses(DNIPRO, 'вул. Робоча');
    expect(http.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([`GET ${BASE}${MAP_PATH}`]);
  });

  it('streets are the keys, sorted', async () => {
    const { p } = setup();
    expect(await p.listStreets(DNIPRO)).toEqual([
      'вул. Національної Гвардії', 'вул. Робоча', 'вул. Філатова', 'ЖК "Грани"', 'пров. Тюленіна',
    ]);
    expect(await p.listStreets('с. Петриківка')).toEqual(['вул. Будівельна', 'вул. Леваневського']);
  });

  it('a city or street resolves exactly, else by nameKey, else is not found', async () => {
    const { p } = setup();
    expect(await p.listStreets('М. ДНІПРО')).toEqual(await p.listStreets(DNIPRO));
    // A Latin «o» and «p» in the street, and another case.
    expect(await p.listHouses('м. дніпро', 'вул. Poбоча')).toEqual(await p.listHouses(DNIPRO, 'вул. Робоча'));
    await expectError(p.listStreets('м. Київ'), AddressNotFoundError, NOT_FOUND);
    await expectError(p.listHouses(DNIPRO, 'вул. Неіснуюча'), AddressNotFoundError, NOT_FOUND);
  });

  it('listHouses: a DTEK house carries the note and no lines; a «Черга N» house has two lines; numeric order', async () => {
    const { p } = setup();
    const gvardii = await p.listHouses(DNIPRO, 'вул. Національної Гвардії');
    expect(gvardii.map((h) => h.house)).toEqual(['5', '9', '11', '13', '13А', '17', '19', '19Г', '30']);
    expect(gvardii.find((h) => h.house === '9')).toEqual({ house: '9', lines: [], outageActive: false, note: CEK_DTEK_NOTE });
    expect(gvardii.find((h) => h.house === '5')).toEqual({ house: '5', lines: [line(1, '3.2')], outageActive: false });
    expect(await p.listHouses(DNIPRO, 'пров. Тюленіна')).toContainEqual({ house: '1', lines: [line(1, '2.1'), line(2, '2.2')], outageActive: false });
    expect(await p.listHouses(DNIPRO, 'ЖК "Грани"')).toEqual([{ house: 'Усі будинки', lines: [line(1, '3.1'), line(2, '3.2')], outageActive: false }]);
    expect(await p.listHouses('с. Петриківка', 'вул. Леваневського')).toEqual([{ house: 'Усі дома', lines: [line(1, '4.1')], outageActive: false }]);
    const sportyvna = await p.listHouses('м. Жовті Води', 'вул. Спортивна');
    expect(sportyvna.find((h) => h.house === '2')?.lines).toEqual([line(1, '2.1'), line(2, '6.1')]);
  });

  it('a key with spaces around it is shown trimmed', async () => {
    const { p } = setup();
    const robocha = (await p.listHouses(DNIPRO, 'вул. Робоча')).map((h) => h.house);
    expect(robocha).toContain('162');
    expect(robocha).not.toContain(' 162');
    expect(robocha).toHaveLength(40);
    const sportyvna = (await p.listHouses('м. Жовті Води', 'вул. Спортивна')).map((h) => h.house);
    expect(sportyvna).toContain('19');
    expect(sportyvna.every((h) => h === h.trim())).toBe(true);
  });

  it('two keys that trim to one text are one house with the union of their lines', async () => {
    const page = swap(MAP_PAGE, ROBOCHA_162, `${ROBOCHA_162},"162 ":"${CHERHA}1.1"`);
    const { p } = setup({ http: fakeHttp({ [MAP]: () => ok(page) }) });
    const robocha = await p.listHouses(DNIPRO, 'вул. Робоча');
    expect(robocha.filter((h) => h.house === '162')).toEqual([{ house: '162', lines: [line(1, '1.1'), line(2, '3.2')], outageActive: false }]);
    expect(robocha).toHaveLength(40);
  });

  it('an unknown map value makes that street\'s house list unreadable, and the error carries no value', async () => {
    const page = swap(MAP_PAGE, ROBOCHA_162, `" 162":"${CHERHA}9.9"`);
    const { p, log } = setup({ http: fakeHttp({ [MAP]: () => ok(page) }) });
    const err = await expectError(p.listHouses(DNIPRO, 'вул. Робоча'), ProviderError, UNREADABLE);
    expect(err.cause).toEqual({ what: 'map', reason: 'unknown queue value' });
    expect(logged(log)).not.toContain('9.9');
    // The other streets of the map still list.
    expect(await p.listHouses(DNIPRO, 'вул. Філатова')).toHaveLength(7);
  });

  it('a failed or odd map page is that error, carries no body, and is not kept', async () => {
    for (const [route, cls, message] of [
      [() => failStatus(404), ProviderError, HTTP_ERROR],
      [() => new Error('ECONNRESET'), ProviderError, NO_ANSWER],
      [() => ok('<html>Технічні роботи</html>'), ProviderError, UNREADABLE],
    ] as const) {
      let fail = true;
      const http = fakeHttp({ [MAP]: () => (fail ? route() : ok(MAP_PAGE)) });
      const { p, log } = setup({ http });
      const err = await expectError(p.listCities(), cls, message);
      expect(JSON.stringify(err.cause)).not.toContain('Технічні');
      expect(logged(log)).not.toContain('Технічні');
      fail = false;
      expect(await p.listCities()).toHaveLength(3);
      expect(http.maps()).toHaveLength(2);
    }
    const offline = setup({ http: fakeHttp({ [MAP]: () => new Error('ERR_INTERNET_DISCONNECTED') }), online: false });
    await expectError(offline.p.listCities(), NetworkError, OFFLINE);
  });
});

describe('CekProvider schedule', () => {
  it('a day with outages: at 15.01.2026 12:00 line 1.1 gets today\'s slots, no tomorrow, no note, no update time', async () => {
    const { p, http, log } = setup();
    const snap = await p.fetchSnapshot(FILATOVA_1);
    expect(DAY_SLOTS['1.1']).toContain('off');
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: DAY_SLOTS['1.1'] }]);
    expect(snap).toMatchObject({
      providerId: 'cek', address: FILATOVA_1, groupId: '1.1', groupLabel: 'Черга 1.1', fetchedAt: at('2026-01-15', 12).toISOString(),
    });
    expect(snap.lines).toEqual([line(1, '1.1')]);
    expect('note' in snap).toBe(false);
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect('currentOutage' in snap).toBe(false);
    expect(http.posts()).toEqual(['queue=all&date=2026-01-15', 'queue=all&date=2026-01-16']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('the quiet day: today all on with the note, no tomorrow; both dates are asked', async () => {
    const { p, http } = setup({ now: at('2026-10-20', 12) });
    const snap = await p.fetchSnapshot(FILATOVA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.note).toBe(CEK_QUIET_NOTE);
    expect(snap.note).toBe('ЦЕК не опублікувала графік на сьогодні — зазвичай це означає, що відключень за графіком немає');
    expect(http.posts()).toEqual(['queue=all&date=2026-10-20', 'queue=all&date=2026-10-21']);
  });

  it('tomorrow is added when its answer has tables', async () => {
    const http = fakeHttp({}, { '2026-01-15': DAY, '2026-01-16': ONE });
    const snap = await setup({ http }).p.fetchSnapshot(FILATOVA_1);
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: DAY_SLOTS['1.1'] }, { date: '2026-01-16', slots: DAY_SLOTS['1.1'] }]);
    // Quiet today, a table tomorrow: today on with the note, and tomorrow.
    const late = await setup({ http: fakeHttp(), now: at('2026-01-14', 21) }).p.fetchSnapshot(FILATOVA_1);
    expect(late.days).toEqual([{ date: '2026-01-14', slots: fill('on') }, { date: '2026-01-15', slots: DAY_SLOTS['1.1'] }]);
    expect(late.note).toBe(CEK_QUIET_NOTE);
  });

  it('a day whose tables lack the saved queue gives that queue all on, with no note', async () => {
    const http = fakeHttp({}, { '2026-01-15': ONE, '2026-01-16': ONE });
    const snap = await setup({ http }).p.fetchSnapshot(ROBOCHA_65);
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: fill('on') }, { date: '2026-01-16', slots: fill('on') }]);
    expect('note' in snap).toBe(false);
    expect(snap.lines).toEqual([line(1, '3.2')]);
  });

  it('a «Черга N» house on its second line reads n.2', async () => {
    const snap = await setup().p.fetchSnapshot(address('пров. Тюленіна', '1', '2.2', 2));
    expect(snap.lines).toEqual([line(1, '2.1'), line(2, '2.2')]);
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: DAY_SLOTS['2.2'] }]);
    expect(DAY_SLOTS['2.2']).not.toEqual(DAY_SLOTS['2.1']);
  });

  it('a saved key with spaces around it is the trimmed house', async () => {
    const snap = await setup().p.fetchSnapshot(address('вул. Робоча', '162', '3.2'));
    expect(snap.lines).toEqual([line(1, '3.2')]);
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: DAY_SLOTS['3.2'] }]);
  });

  it('a moved queue: today unknown with the map\'s lines, and the form is not asked', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...FILATOVA_1, groupId: '1.2' });
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: fill('unknown') }]);
    expect(snap.lines).toEqual([line(1, '1.1')]);
    expect(snap.groupLabel).toBe('Черга 1.2');
    expect(http.posts()).toEqual([]);
  });

  it('a house DTEK now switches: no lines, today unknown, the form is not asked', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot(address('вул. Національної Гвардії', '9', '3.1'));
    expect(snap.lines).toEqual([]);
    expect(snap.days).toEqual([{ date: '2026-01-15', slots: fill('unknown') }]);
    expect(http.posts()).toEqual([]);
  });

  it('the form answering 404, failing or answering an odd page fails the snapshot, today or tomorrow', async () => {
    for (const [route, message] of [
      [() => failStatus(404), HTTP_ERROR],
      [() => new Error('ECONNRESET'), NO_ANSWER],
      [() => ok('<html>Технічні роботи</html>'), UNREADABLE],
    ] as const) {
      for (const date of ['2026-01-15', '2026-01-16']) {
        const http = fakeHttp({ [FORM]: (f) => (f.get('date') === date ? route() : ok(f.get('date') === '2026-01-15' ? DAY : QUIET)) });
        const { p, log } = setup({ http });
        const err = await expectError(p.fetchSnapshot(FILATOVA_1), ProviderError, message);
        expect(JSON.stringify(err.cause)).not.toContain('Технічні');
        expect(logged(log)).not.toContain('Технічні');
      }
    }
  });

  it('an odd answer is unreadable with a fixed reason', async () => {
    const http = fakeHttp({}, { '2026-01-15': swap(DAY, 'id="tableView_6.2"', 'id="tableView_7.1"') });
    const err = await expectError(setup({ http }).p.fetchSnapshot(FILATOVA_1), ProviderError, UNREADABLE);
    expect(err.cause).toMatchObject({ what: 'schedule' });
  });
});

describe('CekProvider.fetchSnapshot address check', () => {
  it('a failed map keeps the saved line, logs one warn, and still delivers the schedule', async () => {
    for (const route of [
      () => failStatus(500),
      () => new Error('ECONNRESET'),
      () => ok('<html>Технічні роботи</html>'),
      () => ok(swap(MAP_PAGE, `"1":"${CHERHA}1.1"`, `"1":"${CHERHA}9.9"`)),
    ] as Route[]) {
      const { p, log } = setup({ http: fakeHttp({ [MAP]: route }) });
      const snap = await p.fetchSnapshot({ ...FILATOVA_1, lineIndex: 2 });
      expect(snap.days).toEqual([{ date: '2026-01-15', slots: DAY_SLOTS['1.1'] }]);
      expect(snap.lines).toEqual([line(2, '1.1')]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('cek fetchSnapshot: address check failed, keeping the saved line', expect.any(ProviderError));
      expect(logged(log)).not.toMatch(/Технічні|9\.9/);
    }
  });

  it('a house, street or city gone from a map that read fine is not found, without asking the form', async () => {
    for (const a of [
      { ...FILATOVA_1, house: '999' },
      { ...FILATOVA_1, street: 'вул. Неіснуюча' },
      { ...FILATOVA_1, city: 'м. Київ' },
    ]) {
      const { p, http } = setup();
      await expectError(p.fetchSnapshot(a), AddressNotFoundError, NOT_FOUND);
      expect(http.posts()).toEqual([]);
    }
  });

  it('the map is read once for the run: by the wizard or by the first refresh', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(FILATOVA_1);
    await p.fetchSnapshot(FILATOVA_1);
    await p.listHouses(DNIPRO, 'вул. Філатова');
    expect(http.maps()).toHaveLength(1);
  });
});

describe('CekProvider requests', () => {
  it('GETs the map plainly and POSTs the form as a urlencoded form, each with a timeout', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(FILATOVA_1);
    expect(http.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${BASE}${MAP_PATH}`, `POST ${BASE}${FORM_PATH}`, `POST ${BASE}${FORM_PATH}`,
    ]);
    for (const c of http.calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      if (c.init.method === 'POST') {
        expect(c.init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
      } else {
        expect(c.init.body).toBeUndefined();
      }
    }
  });

  it('two requests start at least 1000 ms apart (fake clock and sleep)', async () => {
    const { p, sleep } = setup();
    await p.listCities();
    expect(sleep).not.toHaveBeenCalled();
    await p.fetchSnapshot(FILATOVA_1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
