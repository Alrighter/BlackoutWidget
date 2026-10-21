// The schedule pages are real: the live page of 20.10.2026 (a table dated 18.10, all on) and three saved pages of the
// operator's site from Roma7-7-7/sso-notifier (MIT, see the fixtures' README): 31.10.2025 (today only), 05.11.2025
// (the ?next view, with outages) and emergency mode. The tests rewrite a page's day switcher and table date to make the
// default page they need. The district pages are the live trimmed captures, given back the live pages' closing footer;
// the city page ends before «К», so the rows a test saves are appended in its own markup. The outage replies are real:
// planned works on 21.10.2026 for «Чер» / «вул» (page 1 of 6), «Нічого не знайдено» and the form's validation reply.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CvoeProvider, cvoeStaleNote } from '../../src/main/providers/cvoe';
import { cvoeStreets, parseCvoePage, parseDistrictPage } from '../../src/main/providers/cvoe/parse';
import { cvoeSettlements } from '../../src/main/providers/cvoe/settlements';
import { AddressNotFoundError, sortedLabels } from '../../src/main/providers/resolve';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const DIR = join(__dirname, '..', 'fixtures', 'cvoe');
const fx = (n: string): string => readFileSync(join(DIR, n), 'utf8');

const NOV05 = fx('schedule_2025-11-05_next-view_with-outages_from-sso-notifier-MIT.html');
const OCT31 = fx('schedule_2025-10-31_today-only_from-sso-notifier-MIT.html');
const LIVE = fx('schedule_2026-10-20_live_table-dated-18.10_all-on.html');
const EMERGENCY = fx('schedule_emergency-mode_no-gsv_from-sso-notifier-MIT.html');
const D1 = fx('search_d1_Chernivtsi-city_TRIMMED-first-1500-of-25964-rows.html');
const D3 = fx('search_d3_Hertsa_TRIMMED-first-1500-of-6817-rows.html');
const PLANNED = fx('current_planned_2026-10-21_cherniv_Cher-vul_page1.json');
const NOTHING = fx('current_empty_nothing-found.json');
const REQUIRED = fx('current_required-error.json');

const BASE = 'https://oblenergo.cv.ua';
const OUTAGE_FORM = `${BASE}/shutdowns/planovi_avarijni_result.php`;
const NAME = 'Чернівціобленерго';
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

const SWITCHER = /(<div id="gsv_t" class="gsv_info">\s*<div>)[\s\S]*?(<\/div>)/;
const TABLE_DATE = /(<div id="gsv"[^>]*>\s*<ul>\s*<p>)\d{2}\.\d{2}\.\d{4}/;
const isoOf = (dmy: string): string => dmy.split('.').reverse().join('-');

/**
 * A schedule page re-dated to `date` (DD.MM.YYYY) with this day switcher in `#gsv_t`. The result is checked by the
 * reader: a table of that date, with the ?next link exactly when the switcher has it.
 */
function schedulePage(html: string, date: string, switcher: string): string {
  const out = swap(swap(html, SWITCHER, `$1${switcher}$2`), TABLE_DATE, `$1${date}`);
  const page = parseCvoePage(out);
  if (page.kind !== 'table' || page.date !== isoOf(date) || page.nextLink !== switcher.includes('/shutdowns/?next')) {
    throw new Error('the page was not rewritten as asked');
  }
  return out;
}
/** A default page: `<b>date</b>`, and the link to tomorrow's view when `next` is given. */
const defaultPage = (html: string, date: string, next?: string): string =>
  schedulePage(html, date, `<b>${date}</b>${next ? `<a href="/shutdowns/?next">${next}</a>` : ''}`);
/** A ?next view: the link back to today, then `<b>date</b>`. */
const nextView = (html: string, today: string, date: string): string =>
  schedulePage(html, date, `<a href="/shutdowns/">${today}</a><b>${date}</b>`);

/** The live pages close the row list with this footer inside the container; the trimmed captures were cut before it. */
const FOOTER = '<div class="h_total"><p>ще знайдено рядків <b></b></p></div>';
/** A trimmed district page as served live: these rows appended, then the footer. */
const livePage = (trimmed: string, rows = ''): string => swap(trimmed, /<\/div>(\s*<\/main>)/, `${rows}${FOOTER}</div>$1`);
/** The city page (no settlement column) with these rows appended: [street, house, group]. */
const cityPage = (rows: [string, string, string][]): string =>
  livePage(D1, rows.map(([s, h, g]) => `<div><p>${s}</p><b>${h}</b><u>${g}</u></div>`).join(''));
const HERTSA = livePage(D3);
/** «ЛЕОНІДА КАДЕНЮКА» 22А on group 2 is the live page's own row (20.10.2026); the outage form writes the street «вул. КАДЕНЮКА ЛЕОНІДА». */
const CITY_ROWS: [string, string, string][] = [
  ['КАДЕНЮКА ЛЕОНІДА', '22А', '4'], ['КАДЕНЮКА ЛЕОНІДА', 'б/н', '4'], ['КАДЕНЮКА ЛЕОНІДА ПРОВ.', '22А', '4'], ['ПР ЯР', '1', '2'],
  ['ЛЕОНІДА КАДЕНЮКА', '22А', '2'],
];
const CITY = cityPage(CITY_ROWS);

/** The planned reply's rows and pager, to make replies of other pages. */
const PLANNED_DATA = (JSON.parse(PLANNED) as { data: string }).data;
const PLANNED_TRS = [...PLANNED_DATA.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
const PLANNED_ROWS = PLANNED_TRS.filter((tr) => !tr.includes('shop_pages'));
const KADENIUKA_ROW = PLANNED_ROWS.find((tr) => tr.includes('КАДЕНЮКА ЛЕОНІДА,'))!;
const pager = (pages: number): string => `<tr><td colspan="6"><div class="shop_pages" id="pages_list"><div><p>1</p>${
  Array.from({ length: pages - 1 }, (_, i) => `<a data-page="${i + 2}">${i + 2}</a>`).join('')}</div></div></td></tr>`;
/** A reply of these rows, with a pager when there are more pages. */
const reply = (rows: string[], pages = 1): string =>
  JSON.stringify({ test: '=', data: `<tbody>${rows.join('')}${pages > 1 ? pager(pages) : ''}</tbody>` });
/** The planned reply as one page: the provider's search (the settlement's and street's longest words) is far narrower than «Чер» / «вул». */
const PLANNED_ONE_PAGE = reply(PLANNED_ROWS);

type Init = Parameters<HttpFetch>[1];
type Route = (form: URLSearchParams) => HttpResponse | Error;

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});

const SCHEDULE = 'GET /shutdowns/';
const NEXT = 'GET /shutdowns/?next';
const CITY_SEARCH = 'GET /shutdowns-search/1/';
const HERTSA_SEARCH = 'GET /shutdowns-search/3/';
const OUTAGES = 'POST /shutdowns/planovi_avarijni_result.php';

/** The 05.11.2025 table as a default page of that day, without a link to tomorrow. */
const NOV05_TODAY = defaultPage(NOV05, '05.11.2025');

/** Routes by method and path (with the query); the outage form answers «Нічого не знайдено». Any other request rejects. */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    [SCHEDULE]: () => ok(NOV05_TODAY),
    [CITY_SEARCH]: () => ok(CITY),
    [HERTSA_SEARCH]: () => ok(HERTSA),
    [OUTAGES]: () => ok(NOTHING),
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
  const gets = (path: string) => calls.filter((c) => c.init.method === 'GET' && c.url === `${BASE}${path}`);
  const posts = () => calls.filter((c) => c.init.method === 'POST').map((c) => Object.fromEntries(new URLSearchParams(c.init.body)));
  return { fetch, calls, gets, posts };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

/** The provider with a pinned `now`, and a fake clock that the fake sleep moves on: the 1 s spacing costs no time. */
function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: Date; online?: boolean } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let t = 0;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const now = opts.now ?? at('2025-11-05', 12);
  const p = new CvoeProvider({ fetch: http.fetch, isOnline: () => opts.online ?? true, log, now: () => now, sleep, clock: () => t });
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

const CHERNIVTSI = 'м. Чернівці';
const OSTRYTSIA = 'с. Остриця (Герцаївська дільниця)';
const BOHUSLAVSKA_1: Address = { providerId: 'cvoe', city: CHERNIVTSI, street: 'БОГУСЛАВСЬКА', house: '1', lineIndex: 1, groupId: '12' };
const KYSHYNIVSKA_12: Address = { providerId: 'cvoe', city: OSTRYTSIA, street: 'вул. Кишинівська', house: '12', lineIndex: 1, groupId: '1' };
const kadeniuka = (street: string, house = '22А'): Address => ({ providerId: 'cvoe', city: CHERNIVTSI, street, house, lineIndex: 1, groupId: '4' });
const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const LINE_12 = [{ index: 1, groupId: '12', label: 'Група 12' }];
const LINE_1 = [{ index: 1, groupId: '1', label: 'Група 1' }];

const tableOf = (html: string) => {
  const page = parseCvoePage(html);
  if (page.kind !== 'table') throw new Error('not a table');
  return page;
};
const NOV05_12 = tableOf(NOV05).groups['12'];
const OCT31_12 = tableOf(OCT31).groups['12'];

const PLANNED_22A = { kind: 'planned', text: 'Планові роботи', start: '09:00 21.10.2026', end: '20:00 21.10.2026' };
/** On 21.10.2026 the schedule page is the live one (a stale table: a quiet day), and the planned list is `planned`. */
const outageHttp = (planned: Route = () => ok(PLANNED_ONE_PAGE), emergency: Route = () => ok(NOTHING), over: Record<string, Route> = {}) =>
  fakeHttp({ [SCHEDULE]: () => ok(LIVE), [OUTAGES]: (f) => (f.get('v_type') === '0' ? emergency(f) : planned(f)), ...over });
const OCT21_10 = at('2026-10-21', 10);

describe('CvoeProvider address lookup', () => {
  it('listCities is the bundled list and makes no request', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toEqual(cvoeSettlements().map((s) => s.label));
    expect(cities).toContain(CHERNIVTSI);
    expect(cities).toContain(OSTRYTSIA);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('the city\'s streets are every street of district 1, sorted', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets(CHERNIVTSI);
    expect(http.calls.map((c) => [c.url, c.init.method])).toEqual([[`${BASE}/shutdowns-search/1/`, 'GET']]);
    expect(streets).toEqual(sortedLabels(cvoeStreets(parseDistrictPage(CITY, 1))));
    expect(streets).toEqual(expect.arrayContaining(['1-й ПРОВ.ТАДЖИЦЬКИЙ', 'БОГУСЛАВСЬКА', 'КАДЕНЮКА ЛЕОНІДА', 'КАДЕНЮКА ЛЕОНІДА ПРОВ.']));
  });

  it('a district settlement\'s streets are only its own rows', async () => {
    const { p, http } = setup();
    const streets = await p.listStreets(OSTRYTSIA);
    expect(http.gets('/shutdowns-search/3/')).toHaveLength(1);
    expect(streets).toContain('вул. Кишинівська');
    expect(streets).not.toContain('вул. Лилияка'); // a street of м. Герца on the same page
    expect(streets).toHaveLength(41);
    // «м. Чернівці» is a settlement of district 3 too: one row on this page.
    expect(await p.listStreets('м. Чернівці (Герцаївська дільниця)')).toEqual(['вул. Південно-Кільцева']);
    expect(http.gets('/shutdowns-search/3/')).toHaveLength(1);
  });

  it('keeps a district\'s rows for the run, but not a failed read', async () => {
    const { p, http } = setup();
    await p.listStreets(CHERNIVTSI);
    await p.listHouses(CHERNIVTSI, 'БОГУСЛАВСЬКА');
    await p.fetchSnapshot(BOHUSLAVSKA_1);
    await p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(http.gets('/shutdowns-search/1/')).toHaveLength(1);

    let fail = true;
    const flaky = setup({ http: fakeHttp({ [CITY_SEARCH]: () => (fail ? new Error('ECONNRESET') : ok(CITY)) }) });
    await expectError(flaky.p.listStreets(CHERNIVTSI), ProviderError, NO_ANSWER);
    fail = false;
    expect(await flaky.p.listStreets(CHERNIVTSI)).toContain('БОГУСЛАВСЬКА');
    expect(flaky.http.gets('/shutdowns-search/1/')).toHaveLength(2);
  });

  it('an unknown settlement label, or a bare name two districts share, is not found, with no request', async () => {
    const { p, http } = setup();
    await expectError(p.listStreets('Неіснуюче'), AddressNotFoundError, NOT_FOUND);
    await expectError(p.listStreets('с. Остриця'), AddressNotFoundError, NOT_FOUND);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('listHouses gives each house once, without «буд.», with its groups as «Група N» lines', async () => {
    const { p } = setup();
    const houses = await p.listHouses(OSTRYTSIA, 'вул. Кишинівська');
    expect(houses.map((h) => h.house)).toEqual(['1', '2', '8', '12', '14', '15', '19', '21', '44', '86']);
    for (const h of houses) expect(h).toEqual({ house: h.house, lines: LINE_1, outageActive: false });
    // The street is found by nameKey: case and a Latin look-alike do not matter.
    expect(await p.listHouses(CHERNIVTSI, 'богуславська')).toEqual(await p.listHouses(CHERNIVTSI, 'БOГУСЛАВСЬКА'));
  });

  it('an unknown street label is not found', async () => {
    const { p } = setup();
    await expectError(p.listHouses(OSTRYTSIA, 'вул. Неіснуюча'), AddressNotFoundError, NOT_FOUND);
    await expectError(p.listHouses(OSTRYTSIA, 'вул. Лилияка'), AddressNotFoundError, NOT_FOUND);
  });

  it('an odd district page or an odd group is unreadable, and the error carries no body', async () => {
    for (const [route, call] of [
      [() => ok('<html>Технічні роботи</html>'), (p: CvoeProvider) => p.listStreets(CHERNIVTSI)],
      [() => ok(cityPage([['БОГУСЛАВСЬКА', '1', 'А']])), (p: CvoeProvider) => p.listHouses(CHERNIVTSI, 'БОГУСЛАВСЬКА')],
    ] as const) {
      const { p, log } = setup({ http: fakeHttp({ [CITY_SEARCH]: route }) });
      const err = await expectError(call(p), ProviderError, UNREADABLE);
      expect(err.cause).toMatchObject({ what: 'district' });
      expect(JSON.stringify(err.cause)).not.toMatch(/Технічні|БОГУСЛАВСЬКА/);
      expect(logged(log)).not.toMatch(/Технічні|БОГУСЛАВСЬКА/);
    }
  });

  it('a request failing in the wizard is that error', async () => {
    const rejected = setup({ http: fakeHttp({ [CITY_SEARCH]: () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.listStreets(CHERNIVTSI), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ [HERTSA_SEARCH]: () => failStatus(500) }) });
    await expectError(server.p.listHouses(OSTRYTSIA, 'вул. Кишинівська'), ProviderError, HTTP_ERROR);
    const offline = setup({ http: fakeHttp({ [CITY_SEARCH]: () => new Error('ERR_INTERNET_DISCONNECTED') }), online: false });
    await expectError(offline.p.listStreets(CHERNIVTSI), NetworkError, OFFLINE);
  });
});

describe('CvoeProvider schedule', () => {
  it('reads today\'s table: 05.11.2025 at 12:00, БОГУСЛАВСЬКА 1 on group 12', async () => {
    const { p, http, log } = setup();
    const snap = await p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(NOV05_12).toContain('off');
    expect(snap.days).toEqual([{ date: '2025-11-05', slots: NOV05_12 }]);
    expect(snap.sourceUpdatedAt).toBe('20:00 05.11.2025');
    expect(snap).toMatchObject({
      providerId: 'cvoe', address: BOHUSLAVSKA_1, groupId: '12', groupLabel: 'Група 12', fetchedAt: at('2025-11-05', 12).toISOString(),
    });
    expect(snap.lines).toEqual(LINE_12);
    expect('note' in snap).toBe(false);
    expect('currentOutage' in snap).toBe(false);
    expect(http.gets('/shutdowns/')).toHaveLength(1);
    expect(http.gets('/shutdowns/?next')).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('adds tomorrow from ?next when the page links to it and its table is dated tomorrow', async () => {
    const http = fakeHttp({
      [SCHEDULE]: () => ok(defaultPage(OCT31, '04.11.2025', '05.11.2025')),
      [NEXT]: () => ok(NOV05),
    });
    const { p } = setup({ http, now: at('2025-11-04', 21) });
    const snap = await p.fetchSnapshot(BOHUSLAVSKA_1);
    // Two different real tables, so each day shows which page it came from.
    expect(OCT31_12).not.toEqual(NOV05_12);
    expect(snap.days).toEqual([{ date: '2025-11-04', slots: OCT31_12 }, { date: '2025-11-05', slots: NOV05_12 }]);
    expect(snap.sourceUpdatedAt).toBe('12:30 04.11.2025');
    expect(http.gets('/shutdowns/?next')).toHaveLength(1);
  });

  it('a ?next table of any other date, or a ?next in emergency mode, is ignored (Review Focus 2)', async () => {
    for (const next of [nextView(NOV05, '04.11.2025', '04.11.2025'), nextView(NOV05, '04.11.2025', '06.11.2025'), EMERGENCY]) {
      const http = fakeHttp({ [SCHEDULE]: () => ok(defaultPage(OCT31, '04.11.2025', '05.11.2025')), [NEXT]: () => ok(next) });
      const snap = await setup({ http, now: at('2025-11-04', 21) }).p.fetchSnapshot(BOHUSLAVSKA_1);
      expect(snap.days).toEqual([{ date: '2025-11-04', slots: OCT31_12 }]);
      expect('currentOutage' in snap).toBe(false);
    }
  });

  it('a failed or unreadable ?next fails the snapshot', async () => {
    const page = () => ok(defaultPage(OCT31, '04.11.2025', '05.11.2025'));
    for (const [route, message] of [
      [() => new Error('ECONNRESET'), NO_ANSWER],
      [() => failStatus(502), HTTP_ERROR],
      [() => ok('<html>Технічні роботи</html>'), UNREADABLE],
    ] as const) {
      const { p } = setup({ http: fakeHttp({ [SCHEDULE]: page, [NEXT]: route }), now: at('2025-11-04', 21) });
      await expectError(p.fetchSnapshot(BOHUSLAVSKA_1), ProviderError, message);
    }
  });

  it('the live page of 20.10 (a table dated 18.10) is a quiet day with the dated note (Review Focus 2)', async () => {
    const { p, http } = setup({ http: fakeHttp({ [SCHEDULE]: () => ok(LIVE) }), now: at('2026-10-20', 12) });
    const snap = await p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: fill('on') }]);
    expect(snap.note).toBe(cvoeStaleNote('2026-10-18'));
    expect(snap.note).toBe('Чернівціобленерго не опублікувало графік на сьогодні (останній — на 18.10.2026) — '
      + 'зазвичай це означає, що відключень за графіком немає');
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(snap.lines).toEqual(LINE_12);
    expect(http.gets('/shutdowns/?next')).toHaveLength(0);
  });

  it('a stale table never reads ?next, even when the page links to it', async () => {
    const http = fakeHttp({ [SCHEDULE]: () => ok(defaultPage(OCT31, '03.11.2025', '04.11.2025')), [NEXT]: () => ok(NOV05) });
    const snap = await setup({ http, now: at('2025-11-05', 9) }).p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(snap.days).toEqual([{ date: '2025-11-05', slots: fill('on') }]);
    expect(snap.note).toBe(cvoeStaleNote('2025-11-03'));
    expect(http.gets('/shutdowns/?next')).toHaveLength(0);
  });

  it('a default page dated tomorrow, or the day after, is unreadable (Review Focus 2)', async () => {
    for (const date of ['06.11.2025', '07.11.2025']) {
      const { p } = setup({ http: fakeHttp({ [SCHEDULE]: () => ok(defaultPage(NOV05, date)) }) });
      const err = await expectError(p.fetchSnapshot(BOHUSLAVSKA_1), ProviderError, UNREADABLE);
      expect(err.cause).toEqual({ what: 'schedule', reason: 'table dated after today' });
    }
  });

  it('emergency mode: today unknown, the emergency banner as the outage, the saved line kept, no outage lookup', async () => {
    const { p, http } = setup({ http: fakeHttp({ [SCHEDULE]: () => ok(EMERGENCY) }) });
    const snap = await p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(snap.days).toEqual([{ date: '2025-11-05', slots: fill('unknown') }]);
    expect(snap.currentOutage).toEqual({ kind: 'emergency', text: 'Аварійні відключення — графік не діє' });
    expect(snap.lines).toEqual(LINE_12);
    expect(snap.lines.some((l) => l.groupId === BOHUSLAVSKA_1.groupId)).toBe(true);
    expect('note' in snap).toBe(false);
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(http.posts()).toEqual([]);
  });

  it('a moved group: saved 6 where the rows say 12 gives today unknown and the house\'s lines', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ ...BOHUSLAVSKA_1, groupId: '6' });
    expect(snap.days).toEqual([{ date: '2025-11-05', slots: fill('unknown') }]);
    expect(snap.lines).toEqual(LINE_12);
    expect(snap.groupLabel).toBe('Група 6');
    expect(http.gets('/shutdowns/')).toHaveLength(0);
  });

  it('a page of another shape is unreadable, a failed GET is that error, and no error carries the body', async () => {
    const odd = setup({ http: fakeHttp({ [SCHEDULE]: () => ok('<html>Технічні роботи</html>') }) });
    const err = await expectError(odd.p.fetchSnapshot(BOHUSLAVSKA_1), ProviderError, UNREADABLE);
    expect(JSON.stringify(err.cause)).not.toContain('Технічні');
    expect(logged(odd.log)).not.toContain('Технічні');
    const rejected = setup({ http: fakeHttp({ [SCHEDULE]: () => new Error('ECONNRESET') }) });
    await expectError(rejected.p.fetchSnapshot(BOHUSLAVSKA_1), ProviderError, NO_ANSWER);
    const server = setup({ http: fakeHttp({ [SCHEDULE]: () => failStatus(403) }) });
    await expectError(server.p.fetchSnapshot(BOHUSLAVSKA_1), ProviderError, HTTP_ERROR);
  });

  it('a saved group the table does not have is unreadable, never all on, on a stale day too', async () => {
    for (const [page, now] of [[NOV05_TODAY, at('2025-11-05', 12)], [LIVE, at('2026-10-20', 12)]] as const) {
      const http = fakeHttp({ [SCHEDULE]: () => ok(page), [CITY_SEARCH]: () => new Error('ECONNRESET') });
      const { p } = setup({ http, now });
      const err = await expectError(p.fetchSnapshot({ ...BOHUSLAVSKA_1, groupId: '13' }), ProviderError, UNREADABLE);
      expect(err.cause).toEqual({ what: 'schedule', reason: 'no such group' });
    }
  });
});

describe('CvoeProvider.fetchSnapshot address check', () => {
  it('a failed district page keeps the saved line («Група N») and logs one warn', async () => {
    for (const route of [
      () => new Error('ECONNRESET'),
      () => failStatus(500),
      () => ok('<html>Технічні роботи</html>'),
      () => ok(cityPage([['БОГУСЛАВСЬКА', '1', 'А']])),
    ] as Route[]) {
      const { p, log } = setup({ http: fakeHttp({ [CITY_SEARCH]: route }) });
      const snap = await p.fetchSnapshot({ ...BOHUSLAVSKA_1, lineIndex: 2 });
      expect(snap.days).toEqual([{ date: '2025-11-05', slots: NOV05_12 }]);
      expect(snap.lines).toEqual([{ index: 2, groupId: '12', label: 'Група 12' }]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('cvoe fetchSnapshot: address check failed, keeping the saved line', expect.any(ProviderError));
      expect(logged(log)).not.toContain('Технічні');
    }
  });

  it('a house gone from rows that read fine is not found, without reading the schedule', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...BOHUSLAVSKA_1, house: '999' }), AddressNotFoundError, NOT_FOUND);
    expect(http.gets('/shutdowns/')).toHaveLength(0);
  });

  it('a street gone from rows that read fine, or a settlement gone from the bundle, is not found', async () => {
    const { p, http } = setup();
    await expectError(p.fetchSnapshot({ ...BOHUSLAVSKA_1, street: 'НЕІСНУЮЧА' }), AddressNotFoundError, NOT_FOUND);
    expect(http.gets('/shutdowns/')).toHaveLength(0);
    const gone = setup();
    await expectError(gone.p.fetchSnapshot({ ...BOHUSLAVSKA_1, city: 'Неіснуюче' }), AddressNotFoundError, NOT_FOUND);
    expect(gone.http.fetch).not.toHaveBeenCalled();
  });

  it('a saved «12А» matches the row written «буд. 12 а» (Review Focus 4)', async () => {
    const http = fakeHttp({ [HERTSA_SEARCH]: () => ok(swap(HERTSA, '<b>буд. 12</b><u>1</u>', '<b>буд. 12 а</b><u>1</u>')) });
    const { p, log } = setup({ http });
    for (const house of ['12А', '12-а', '12 a']) {
      const snap = await p.fetchSnapshot({ ...KYSHYNIVSKA_12, house });
      expect(snap.lines).toEqual(LINE_1);
      expect(snap.days).toEqual([{ date: '2025-11-05', slots: tableOf(NOV05).groups['1'] }]);
    }
    expect(log.warn).not.toHaveBeenCalled();
    await expectError(p.fetchSnapshot(KYSHYNIVSKA_12), AddressNotFoundError, NOT_FOUND);
  });

  it('a house on two groups has both lines', async () => {
    const http = fakeHttp({ [CITY_SEARCH]: () => ok(cityPage([['БОГУСЛАВСЬКА', '1', '8']])) });
    const snap = await setup({ http }).p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(snap.lines).toEqual([{ index: 1, groupId: '8', label: 'Група 8' }, { index: 2, groupId: '12', label: 'Група 12' }]);
    expect(snap.days).toEqual([{ date: '2025-11-05', slots: NOV05_12 }]);
  });
});

describe('CvoeProvider current outage', () => {
  it('at 10:00 on 21.10.2026 КАДЕНЮКА ЛЕОНІДА 22А is in the planned works of 09:00-20:00', async () => {
    const { p, http, log } = setup({ http: outageHttp(), now: OCT21_10 });
    const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect(snap.currentOutage).toEqual(PLANNED_22A);
    expect(snap.days).toEqual([{ date: '2026-10-21', slots: fill('on') }]);
    expect(snap.note).toBe(cvoeStaleNote('2026-10-18'));
    const form = { v_diln: '1', v_city: 'чернівці', v_street: 'каденюка', v_house: '22', v_date: '21.10.2026', v_sort_field: '4', v_sort_type: '0', v_page: '1' };
    expect(http.posts()).toEqual([{ v_type: '0', ...form }, { v_type: '1', ...form }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('the search page\'s own spelling «ЛЕОНІДА КАДЕНЮКА» joins the form\'s «вул. КАДЕНЮКА ЛЕОНІДА» by its words', async () => {
    const { p, http } = setup({ http: outageHttp(), now: OCT21_10 });
    const snap = await p.fetchSnapshot({ ...kadeniuka('ЛЕОНІДА КАДЕНЮКА'), groupId: '2' });
    expect(snap.lines).toEqual([{ index: 1, groupId: '2', label: 'Група 2' }]);
    expect(snap.currentOutage).toEqual(PLANNED_22A);
    expect(http.posts().map((f) => f.v_street)).toEqual(['каденюка', 'каденюка']);
  });

  it('the same house on «КАДЕНЮКА ЛЕОНІДА ПРОВ.» gets none: a namesake street\'s rows never count', async () => {
    const { p, http } = setup({ http: outageHttp(), now: OCT21_10 });
    const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА ПРОВ.'));
    expect('currentOutage' in snap).toBe(false);
    expect(http.posts()).toHaveLength(2);
  });

  it('a row of another settlement never counts', async () => {
    const other = reply([swap(KADENIUKA_ROW, 'м. <b>Чер</b>нівці', 'с. Нові <b>Чер</b>нівці')]);
    const snap = await setup({ http: outageHttp(() => ok(other)), now: OCT21_10 }).p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect('currentOutage' in snap).toBe(false);
  });

  it('counts from its start up to, not at, its end', async () => {
    const run = async (now: Date) => (await setup({ http: outageHttp(), now }).p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'))).currentOutage;
    expect(await run(at('2026-10-21', 9))).toEqual(PLANNED_22A);
    expect(await run(at('2026-10-21', 19, 59))).toEqual(PLANNED_22A);
    expect(await run(at('2026-10-21', 20))).toBeUndefined();
    expect(await run(at('2026-10-21', 8, 59))).toBeUndefined();
  });

  it('a house without leading digits is asked without v_house and matched by its key', async () => {
    const { p, http } = setup({ http: outageHttp(), now: OCT21_10 });
    const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА', 'б/н'));
    expect(snap.currentOutage).toEqual(PLANNED_22A);
    expect(http.posts().every((f) => !('v_house' in f))).toBe(true);
  });

  it('an emergency wins, and the planned list is then not asked', async () => {
    const emergency = () => ok(reply([KADENIUKA_ROW]));
    const { p, http } = setup({ http: outageHttp(undefined, emergency), now: OCT21_10 });
    const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect(snap.currentOutage).toEqual({ ...PLANNED_22A, kind: 'emergency', text: 'Аварійне відключення' });
    expect(http.posts().map((f) => f.v_type)).toEqual(['0']);
  });

  it('reads every page up to the last, and a search of more than 5 pages gives none (logged)', async () => {
    const others = PLANNED_ROWS.filter((tr) => tr !== KADENIUKA_ROW);
    const paged = (f: URLSearchParams) => ok(f.get('v_page') === '1' ? reply(others, 2) : reply([KADENIUKA_ROW], 2));
    const two = setup({ http: outageHttp(paged), now: OCT21_10 });
    expect((await two.p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'))).currentOutage).toEqual(PLANNED_22A);
    expect(two.http.posts().map((f) => [f.v_type, f.v_page])).toEqual([['0', '1'], ['1', '1'], ['1', '2']]);

    // The fixture as captured: page 1 of 6.
    const six = setup({ http: outageHttp(() => ok(PLANNED)), now: OCT21_10 });
    const snap = await six.p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect('currentOutage' in snap).toBe(false);
    expect(snap.days).toEqual([{ date: '2026-10-21', slots: fill('on') }]);
    expect(six.http.posts().map((f) => [f.v_type, f.v_page])).toEqual([['0', '1'], ['1', '1']]);
    expect(six.log.warn).toHaveBeenCalledTimes(1);
    expect(six.log.warn).toHaveBeenCalledWith('cvoe fetchSnapshot: current outage lookup failed', expect.any(ProviderError));
  });

  it('a required_error reply gives no outage, and the schedule still comes', async () => {
    const { p, log } = setup({ http: outageHttp(undefined, () => ok(REQUIRED)), now: OCT21_10 });
    const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect('currentOutage' in snap).toBe(false);
    expect(snap.days).toEqual([{ date: '2026-10-21', slots: fill('on') }]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('cvoe fetchSnapshot: current outage lookup failed', expect.any(ProviderError));
    expect(logged(log)).not.toContain('Оберіть');
  });

  it('a reply that is not JSON, or a failed POST, gives no outage, and the log carries no body', async () => {
    for (const route of [() => ok('<html>Пошкодження</html>'), () => new Error('ECONNRESET'), () => failStatus(500)] as Route[]) {
      const { p, log } = setup({ http: outageHttp(route), now: OCT21_10 });
      const snap = await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
      expect('currentOutage' in snap).toBe(false);
      expect(snap.days).toEqual([{ date: '2026-10-21', slots: fill('on') }]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(logged(log)).not.toContain('Пошкодження');
    }
  });

  it('posts the form\'s own district id: v_diln=1 for district 1, v_diln=2 for district 3', async () => {
    const city = setup();
    await city.p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(city.http.posts().map((f) => f.v_diln)).toEqual(['1', '1']);
    expect(city.http.posts()[0]).toMatchObject({ v_city: 'чернівці', v_street: 'богуславська', v_house: '1', v_date: '05.11.2025' });

    const hertsa = setup();
    await hertsa.p.fetchSnapshot(KYSHYNIVSKA_12);
    expect(hertsa.http.posts().map((f) => f.v_diln)).toEqual(['2', '2']);
    expect(hertsa.http.posts()[0]).toMatchObject({ v_city: 'остриця', v_street: 'кишинівська', v_house: '12' });
  });

  it('a word with an apostrophe is searched by its longest piece: the site writes U+0027, never ’ (R5)', async () => {
    const kamiana = cvoeSettlements().find((s) => s.name === 'с. Кам\'яна')!;
    expect(kamiana.district).toBe(11);
    const district = livePage(D3, '<div><s>с. Кам\'яна</s><p>вул. Здоров\'я</p><b>буд. 22А</b><u>3</u></div>');
    // The reply as the site writes it: a raw ', and the matched pieces in <b>.
    const row = swap(swap(KADENIUKA_ROW, 'м. <b>Чер</b>нівці', 'с. <b>Кам</b>\'яна'), '<b>вул</b>. КАДЕНЮКА ЛЕОНІДА', 'вул. <b>Здоров</b>\'я');
    const http = outageHttp(() => ok(reply([row])), undefined, { 'GET /shutdowns-search/11/': () => ok(district) });
    const snap = await setup({ http, now: OCT21_10 }).p.fetchSnapshot({
      providerId: 'cvoe', city: kamiana.label, street: 'вул. Здоров\'я', house: '22А', lineIndex: 1, groupId: '3',
    });
    expect(snap.lines).toEqual([{ index: 1, groupId: '3', label: 'Група 3' }]);
    expect(snap.currentOutage).toEqual(PLANNED_22A);
    expect(http.posts().map((f) => [f.v_diln, f.v_city, f.v_street])).toEqual([['4', 'кам', 'здоров'], ['4', 'кам', 'здоров']]);
  });

  it('a street whose longest piece between apostrophes is under 3 letters is not looked up', async () => {
    const http = fakeHttp({ [CITY_SEARCH]: () => ok(cityPage([['Б\'ЯК', '1', '2']])) });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot({ providerId: 'cvoe', city: CHERNIVTSI, street: 'Б\'ЯК', house: '1', lineIndex: 1, groupId: '2' });
    expect(snap.lines).toEqual([{ index: 1, groupId: '2', label: 'Група 2' }]);
    expect(http.posts()).toEqual([]);
  });

  it('a settlement or street without a word of 3 letters is not looked up', async () => {
    const { p, http } = setup();
    const snap = await p.fetchSnapshot({ providerId: 'cvoe', city: CHERNIVTSI, street: 'ПР ЯР', house: '1', lineIndex: 1, groupId: '2' });
    expect(snap.lines).toEqual([{ index: 1, groupId: '2', label: 'Група 2' }]);
    expect(http.posts()).toEqual([]);
  });
});

describe('CvoeProvider requests', () => {
  it('GETs the pages plainly and POSTs the outage form as an XHR form, each with a timeout', async () => {
    const { p, http } = setup({ http: outageHttp(), now: OCT21_10 });
    await p.listHouses(CHERNIVTSI, 'КАДЕНЮКА ЛЕОНІДА');
    await p.fetchSnapshot(kadeniuka('КАДЕНЮКА ЛЕОНІДА'));
    expect(http.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${BASE}/shutdowns-search/1/`, `GET ${BASE}/shutdowns/`, `POST ${OUTAGE_FORM}`, `POST ${OUTAGE_FORM}`,
    ]);
    for (const c of http.calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      if (c.init.method === 'POST') {
        expect(c.init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' });
      } else {
        expect(c.init.body).toBeUndefined();
      }
    }
  });

  it('two requests start at least 1000 ms apart (fake clock and sleep)', async () => {
    const { p, sleep } = setup();
    await p.listStreets(CHERNIVTSI);
    expect(sleep).not.toHaveBeenCalled();
    await p.fetchSnapshot(BOHUSLAVSKA_1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
