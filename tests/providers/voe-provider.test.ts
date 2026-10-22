import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOE_QUIET_NOTE, VoeProvider } from '../../src/main/providers/voe';
import { housesOf, parseQueueTable } from '../../src/main/providers/voe/html';
import { voeSettlements } from '../../src/main/providers/voe/settlements';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import type { Address, Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', 'voe', n));
const ARCHIVE = JSON.parse(fx('archive-page1.json').toString('utf8'));
const PNG17 = fx('gpv-2026-10-17.png');
const PNG20 = fx('gpv-2026-10-20.png');
const CHERGA = fx('cherga-kovel-all.html').toString('utf8');
const CHOMU = fx('chomu-nemaie-kovel.html').toString('utf8');
const EMPTY_PAGE = '<html><body><p>Повернутись до форми пошуку</p></body></html>';

const API = 'https://api-voe-poweron.inneti.net';
const ARCHIVE_URL = `${API}/api/archive_gpv_graphs?page=1`;
const SITE = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni';
const CHERGA_URL = `${SITE}/cherga/`;
const CHOMU_URL = `${SITE}/chomu-nemaie-elektropostachannia/`;
const IMG = {
  d20: `${API}/media/2026/10/6ad66ecc04352_GPV.png`, // id 620, dateGraph 2026-10-20
  d19: `${API}/media/2026/10/6ad51ee91eab9_GPV.png`, // id 619, 2026-10-19
  d18: `${API}/media/2026/10/6ad3c89bb9049_GPV.png`, // id 618, the newer of the two 2026-10-18 entries
  d17: `${API}/media/2026/10/6ad3988b22570_GPV.png`, // id 616, the newest of the seven 2026-10-17 entries
};

const UNREADABLE = 'Не вдалося прочитати графік Волиньобленерго';
const OFFLINE = 'Немає з’єднання з сайтом Волиньобленерго';
const NO_ANSWER = 'Сайт Волиньобленерго не відповідає';
const HTTP_ERROR = 'Сайт Волиньобленерго повернув помилку';

type Init = Parameters<HttpFetch>[1];
type Route = (init: Init) => HttpResponse | Error;

const okText = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const okBytes = (buf: Buffer): HttpResponse => ({
  ok: true, status: 200, text: async () => buf.toString('latin1'),
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
});
const failStatus = (status: number): HttpResponse => ({
  ok: false, status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
});
const form = (init: Init) => new URLSearchParams(init.body ?? '');

// Same-named villages: Заріччя is in three districts. The operator spells one district with a Latin «c» (U+0063).
const VOLODYMYR_LATIN = 'Володимирcький';
const queueTable = (rows: string[][]) => okText(
  "<table class='table table-sm table-light'><tr class='fw-bold'><td>Район</td><td>Нас. пункт</td><td>Вулиця</td>"
  + '<td>Будинок</td><td>Черга у ГПВ</td><td>Черга у ГАВ</td></tr>'
  + rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}<td>Не залучено</td></tr>`).join('')
  + '</table>',
);
const ZARICHCHIA = [
  [VOLODYMYR_LATIN, 'Заріччя', 'Шкільна', '1', '3.1'],
  ['Ковельський', 'Заріччя', 'Польова', '2, 7А', '4.1'],
  ['Луцький', 'Заріччя', 'Лісова', '3', '5.1'],
  ['Луцький', 'Заріччя-Нове', 'Садова', '4', '5.2'],
];
// The fixture's Самійла Величка emergency (09:50-11:51 on 20.10, houses incl. 7А), moved to Заріччя, Польова.
const VELYCHKA_ROW = /<tr><td>Ковельський<\/td><td>Ковель<\/td><td>Самійла Величка<\/td>[\s\S]*?<\/tr>/.exec(CHOMU)![0];
const zarichchiaOutages = (variants: { raion: string; planned?: boolean }[], settlement = 'Заріччя') => okText(CHOMU.replace(
  VELYCHKA_ROW,
  variants.map((v) => {
    const row = VELYCHKA_ROW.replace(
      '<td>Ковельський</td><td>Ковель</td><td>Самійла Величка</td>', `<td>${v.raion}</td><td>${settlement}</td><td>Польова</td>`,
    );
    return v.planned
      ? row.replace('Аварійне вимкнення', 'Планове вимкнення').replace('Аварійний випадок в мережах', 'Планові ремонтні роботи')
      : row;
  }).join(''),
));
const archiveWith = (patch: (members: any[]) => any[]) => {
  const copy = structuredClone(ARCHIVE);
  copy['hydra:member'] = patch(copy['hydra:member']);
  return okText(JSON.stringify(copy));
};

/**
 * Routes by URL to the saved responses. The cherga/chomu pages answer only for formCity=Ковель, like the live forms
 * (another city gets the page without a table). An unknown URL rejects, so a wrong pick fails the test.
 */
function fakeHttp(over: Record<string, Route> = {}) {
  const calls: { url: string; init: Init }[] = [];
  const routes: Record<string, Route> = {
    [ARCHIVE_URL]: () => okText(JSON.stringify(ARCHIVE)),
    [IMG.d20]: () => okBytes(PNG20),
    [IMG.d17]: () => okBytes(PNG17),
    // Stand-ins: the research parsed the 18.10 and 19.10 images as all on, like 20.10.
    [IMG.d19]: () => okBytes(PNG20),
    [IMG.d18]: () => okBytes(PNG20),
    [CHERGA_URL]: (init) => okText(form(init).get('formCity') === 'Ковель' ? CHERGA : EMPTY_PAGE),
    [CHOMU_URL]: (init) => okText(form(init).get('formCity') === 'Ковель' ? CHOMU : EMPTY_PAGE),
    ...over,
  };
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    const r = route(init);
    if (r instanceof Error) throw r;
    return r;
  });
  return { fetch, calls, count: (url: string) => calls.filter((c) => c.url === url).length };
}

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

function setup(opts: { http?: ReturnType<typeof fakeHttp>; now?: () => Date; online?: boolean } = {}) {
  const http = opts.http ?? fakeHttp();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const now = opts.now ?? (() => at('2026-10-20', 10));
  const p = new VoeProvider({ fetch: http.fetch, isOnline: () => opts.online ?? true, log, now });
  return { p, http, log };
}

const KOVEL: Address = {
  providerId: 'voe', city: 'м. Ковель', street: 'Самійла Величка', house: '7А', lineIndex: 1, groupId: '6.1',
};
const ALL_ON: Slot[] = Array<Slot>(48).fill('on');
const offBetween = (a: number, b: number): Slot[] => Array.from({ length: 48 }, (_, i) => (i >= a && i < b ? 'off' : 'on'));

async function expectError(p: Promise<unknown>, cls: typeof ProviderError, message: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
  return err as Error;
}

describe('VoeProvider.fetchSnapshot', () => {
  it('reads 20.10 for Самійла Величка 7А with the emergency outage', async () => {
    const { p } = setup();
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: ALL_ON }]);
    expect('note' in snap).toBe(false);
    expect(snap.sourceUpdatedAt).toBe('22:26 19.10.2026');
    expect(snap.currentOutage).toEqual({
      kind: 'emergency', text: 'Аварійний випадок в мережах', start: '20.10.2026 09:50', end: '20.10.2026 11:51',
    });
    expect(snap).toMatchObject({
      providerId: 'voe', address: KOVEL, groupId: '6.1', groupLabel: 'Черга 6.1', fetchedAt: at('2026-10-20', 10).toISOString(),
    });
    // The operator lists this house in queue 1.2, not the saved 6.1: the lines follow the operator.
    expect(snap.lines).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect(snap.outageActive).toBeFalsy();
  });

  it('reads the 17.10 outages of queue 1.1 from the newest 17.10 image', async () => {
    const { p, http } = setup({ now: () => at('2026-10-17', 12) });
    const snap = await p.fetchSnapshot({ ...KOVEL, groupId: '1.1' });
    expect(snap.days[0]).toEqual({ date: '2026-10-17', slots: offBetween(20, 28) });
    expect(snap.days.map((d) => d.date)).toEqual(['2026-10-17', '2026-10-18']);
    expect(snap.sourceUpdatedAt).toBe('18:47 17.10.2026');
    expect(http.count(IMG.d17)).toBe(1);
  });

  it('shows a day with no image as all on with the quiet note, and leaves tomorrow out', async () => {
    const { p, http } = setup({ now: () => at('2026-10-21', 10) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.days).toEqual([{ date: '2026-10-21', slots: ALL_ON }]);
    expect(snap.note).toBe(VOE_QUIET_NOTE);
    expect('sourceUpdatedAt' in snap).toBe(false);
    expect(http.calls.some((c) => c.url.endsWith('.png'))).toBe(false);
  });

  it('adds tomorrow once its image is out', async () => {
    const { p } = setup({ now: () => at('2026-10-19', 21) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.days.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-20']);
    expect('note' in snap).toBe(false);
    expect(snap.sourceUpdatedAt).toBe('22:32 18.10.2026');
  });

  it('at 00:05 the image that was tomorrow is today, keyed by dateGraph, not a quiet day (Review Focus 2)', async () => {
    // 20.10 is routed to the 17.10 picture so its slots are recognisable.
    const http = fakeHttp({ [IMG.d20]: () => okBytes(PNG17) });
    let now = at('2026-10-19', 21);
    const { p } = setup({ http, now: () => now });
    const address = { ...KOVEL, groupId: '1.1' };

    const evening = await p.fetchSnapshot(address);
    expect(evening.days[1]).toEqual({ date: '2026-10-20', slots: offBetween(20, 28) });

    now = at('2026-10-20', 0, 5);
    const night = await p.fetchSnapshot(address);
    expect(night.days).toEqual([{ date: '2026-10-20', slots: offBetween(20, 28) }]);
    expect('note' in night).toBe(false);
    expect(night.sourceUpdatedAt).toBe('22:26 19.10.2026');
    expect(http.count(IMG.d20)).toBe(1);
  });

  it('fails as unreadable when the archive is empty', async () => {
    const { p } = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => archiveWith(() => []) }) });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
  });

  it('fails as unreadable when the newest entry has no sane date', async () => {
    const { p } = setup({
      http: fakeHttp({ [ARCHIVE_URL]: () => archiveWith((m) => [{ ...m[0], dateGraph: 'вчора' }, ...m.slice(1)]) }),
    });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
  });

  it('fails as unreadable when the newest picture is not first on the page', async () => {
    // Page 1 in another order would hold old days, and every day would read as a quiet «світло є».
    const reversed = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => archiveWith((m) => [...m].reverse()) }) });
    await expectError(reversed.p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
    const noId = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => archiveWith((m) => [{ ...m[0], id: undefined }, ...m.slice(1)]) }) });
    await expectError(noId.p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
  });

  it('fails as unreadable when the archive is not JSON', async () => {
    const { p } = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => okText('<html>maintenance</html>') }) });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
  });

  it('never fetches an image from another host', async () => {
    const http = fakeHttp({
      [ARCHIVE_URL]: () => archiveWith((m) => [{ ...m[0], imageUrl: { ...m[0].imageUrl, contentUrl: '@evil.example/x.png' } }, ...m.slice(1)]),
    });
    const { p } = setup({ http });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
    expect(http.calls.map((c) => c.url)).toEqual([ARCHIVE_URL]);
  });

  it('fails as unreadable for a queue the image does not have', async () => {
    const { p } = setup();
    await expectError(p.fetchSnapshot({ ...KOVEL, groupId: '7.1' }), ProviderError, UNREADABLE);
  });

  it('downloads an image once for two fetches', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(KOVEL);
    await p.fetchSnapshot(KOVEL);
    expect(http.count(ARCHIVE_URL)).toBe(2);
    expect(http.count(IMG.d20)).toBe(1);
  });

  it('keeps the last four images', async () => {
    let path = '';
    const images = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [`${API}/media/t/${k}.png`, () => okBytes(PNG20)]));
    const http = fakeHttp({
      ...images,
      [ARCHIVE_URL]: () => archiveWith((m) => [{ ...m[0], imageUrl: { ...m[0].imageUrl, contentUrl: path } }, ...m.slice(1)]),
    });
    const { p } = setup({ http });
    for (const k of ['a', 'b', 'c', 'd', 'e', 'e', 'b', 'a']) {
      path = `/media/t/${k}.png`;
      await p.fetchSnapshot(KOVEL);
    }
    const count = (k: string) => http.count(`${API}/media/t/${k}.png`);
    expect([count('a'), count('b'), count('e')]).toEqual([2, 1, 1]);
  });

  it('sends the documented requests, each with a timeout', async () => {
    const { p, http } = setup();
    await p.fetchSnapshot(KOVEL);
    expect(http.calls.every((c) => c.init.signal instanceof AbortSignal)).toBe(true);
    const archive = http.calls.find((c) => c.url === ARCHIVE_URL)!;
    expect(archive.init).toMatchObject({ method: 'GET', headers: { Accept: 'application/ld+json' } });
    const urlencoded = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    const cherga = http.calls.find((c) => c.url === CHERGA_URL)!;
    expect(cherga.init).toMatchObject({ method: 'POST', headers: urlencoded });
    expect(Object.fromEntries(form(cherga.init))).toEqual({ formCity: 'Ковель', formStreet: '%' });
    const chomu = http.calls.find((c) => c.url === CHOMU_URL)!;
    expect(chomu.init).toMatchObject({ method: 'POST', headers: urlencoded });
    // The street is left blank, as in the browser form: the whole settlement comes back and the street is matched here,
    // whatever apostrophe or look-alike letter the operator wrote it with.
    expect(Object.fromEntries(form(chomu.init))).toEqual({
      formCity: 'Ковель', formStreet: '', searchForm: 'searchFromForm',
    });
  });

  it('gives queue none the same dates, all on, without reading the image', async () => {
    const { p, http } = setup({ now: () => at('2026-10-17', 12) });
    const snap = await p.fetchSnapshot({ ...KOVEL, groupId: 'none' });
    expect(snap.days).toEqual([{ date: '2026-10-17', slots: ALL_ON }, { date: '2026-10-18', slots: ALL_ON }]);
    expect(snap.groupLabel).toBe('Не залучено до ГПВ');
    expect(snap.sourceUpdatedAt).toBe('18:47 17.10.2026');
    expect(http.count(IMG.d17)).toBe(0);
  });

  it('finds the outage when the operator writes the street\'s apostrophe and the house letter differently', async () => {
    // The outage row: U+0027 in the street and a Latin «A» in «7A»; the saved address: U+2019 and the Cyrillic «7А».
    const row = VELYCHKA_ROW.replace('<td>Самійла Величка</td>', "<td>Левка Лук'яненка</td>").replace(', 7А,', ', 7A,');
    const { p } = setup({ http: fakeHttp({ [CHOMU_URL]: () => okText(CHOMU.replace(VELYCHKA_ROW, row)) }) });
    const snap = await p.fetchSnapshot({ ...KOVEL, street: 'Левка Лук’яненка' });
    expect(snap.currentOutage).toMatchObject({ kind: 'emergency', text: 'Аварійний випадок в мережах' });
  });

  it('a unique settlement takes its outage whatever district the row names', async () => {
    // No other district has a Ковель: the district plays no part, even though the queue table has one.
    const row = VELYCHKA_ROW.replace('<td>Ковельський</td>', '<td>Луцький</td>');
    const { p } = setup({ http: fakeHttp({ [CHOMU_URL]: () => okText(CHOMU.replace(VELYCHKA_ROW, row)) }) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.currentOutage).toMatchObject({ kind: 'emergency', text: 'Аварійний випадок в мережах' });
  });

  it('a half-uploaded picture for today fails as unreadable, never a quiet day (Review Focus 1)', async () => {
    const cut = PNG20.subarray(0, Math.floor(PNG20.length * 0.7));
    const { p } = setup({ http: fakeHttp({ [IMG.d20]: () => okBytes(cut) }) });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, UNREADABLE);
  });

  it('a city missing from the bundled list still refreshes by its bare name (Review Focus 3)', async () => {
    const { p, http } = setup();
    const address = { ...KOVEL, city: 'м. Ковель (Старий р-н)' };
    const snap = await p.fetchSnapshot(address);
    const posts = http.calls.filter((c) => c.init.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([CHERGA_URL, CHOMU_URL]);
    expect(posts.map((c) => form(c.init).get('formCity'))).toEqual(['Ковель', 'Ковель']);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: ALL_ON }]);
    expect(snap.lines).toEqual([{ index: 1, groupId: '1.2', label: 'Черга 1.2' }]);
    expect(snap.currentOutage?.kind).toBe('emergency');
    expect(snap.currentOutage?.text).toBe('Аварійний випадок в мережах');
  });
});

describe('VoeProvider soft failures in fetchSnapshot', () => {
  it('delivers the snapshot without currentOutage when the outage form fails', async () => {
    const { p, log } = setup({ http: fakeHttp({ [CHOMU_URL]: () => new Error('ECONNRESET') }) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: ALL_ON }]);
    expect('currentOutage' in snap).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^voe /), expect.anything());
  });

  it('keeps the saved line when the queue form rejects', async () => {
    const { p, log } = setup({ http: fakeHttp({ [CHERGA_URL]: () => new Error('ECONNRESET') }) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.lines).toEqual([{ index: 1, groupId: '6.1', label: 'Черга 6.1' }]);
    expect(snap.currentOutage?.kind).toBe('emergency');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^voe /), expect.anything());
  });

  it('keeps the saved line when the queue form returns an error status', async () => {
    const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => failStatus(502) }) });
    const snap = await p.fetchSnapshot(KOVEL);
    expect(snap.lines).toEqual([{ index: 1, groupId: '6.1', label: 'Черга 6.1' }]);
  });

  it('keeps the saved line when the table has no row for the house', async () => {
    const { p, log } = setup();
    const snap = await p.fetchSnapshot({ ...KOVEL, house: '999', lineIndex: 2, groupId: 'none' });
    expect(snap.lines).toEqual([{ index: 2, groupId: 'none', label: 'Не залучено до ГПВ' }]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^voe /), expect.anything());
  });
});

describe('VoeProvider current outage in same-named villages', () => {
  const zarichchia = (label: string): Address => ({
    providerId: 'voe', city: label, street: 'Польова', house: '7А', lineIndex: 1, groupId: '4.1',
  });
  const KOVELSKYI = zarichchia('с. Заріччя (Ковельський р-н)');

  it('takes only the saved district\'s row when two districts list the house', async () => {
    // The queue lookup fails, so only the outage rows show which districts the operator uses.
    const http = fakeHttp({
      [CHERGA_URL]: () => new Error('ECONNRESET'),
      [CHOMU_URL]: () => zarichchiaOutages([{ raion: VOLODYMYR_LATIN }, { raion: 'Ковельський', planned: true }]),
    });
    const { p } = setup({ http });
    const kovel = await p.fetchSnapshot(KOVELSKYI);
    expect(kovel.currentOutage).toMatchObject({ kind: 'planned', text: 'Планові ремонтні роботи' });
    const volodymyr = await p.fetchSnapshot(zarichchia('с. Заріччя (Володимирський р-н)'));
    expect(volodymyr.currentOutage).toMatchObject({ kind: 'emergency', text: 'Аварійний випадок в мережах' });
  });

  it('ignores a namesake\'s outage while the saved district has none', async () => {
    // The queue table files Заріччя under Ковельський, so a Володимирський row never matches.
    const http = fakeHttp({
      [CHERGA_URL]: () => queueTable(ZARICHCHIA),
      [CHOMU_URL]: () => zarichchiaOutages([{ raion: VOLODYMYR_LATIN }]),
    });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot(KOVELSKYI);
    expect(snap.lines).toEqual([{ index: 1, groupId: '4.1', label: 'Черга 4.1' }]);
    expect('currentOutage' in snap).toBe(false);
  });

  it('ignores a namesake\'s outage for a village whose label names no district', async () => {
    // с. Луків is in Луцький; the outage is in с-ще Луків, Ковельський. The labels differ by kind only.
    const http = fakeHttp({
      [CHERGA_URL]: () => queueTable([['Луцький', 'Луків', 'Польова', '7А', '4.1']]),
      [CHOMU_URL]: () => zarichchiaOutages([{ raion: 'Ковельський' }], 'Луків'),
    });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot({ ...KOVELSKYI, city: 'с. Луків' });
    expect(snap.lines).toEqual([{ index: 1, groupId: '4.1', label: 'Черга 4.1' }]);
    expect('currentOutage' in snap).toBe(false);
  });

  it('matches by name when the operator has no row in the saved district', async () => {
    const http = fakeHttp({
      [CHERGA_URL]: () => queueTable(ZARICHCHIA.filter((r) => r[0] !== 'Ковельський')),
      [CHOMU_URL]: () => zarichchiaOutages([{ raion: VOLODYMYR_LATIN }]),
    });
    const { p } = setup({ http });
    const snap = await p.fetchSnapshot(KOVELSKYI);
    expect(snap.currentOutage).toMatchObject({ kind: 'emergency', text: 'Аварійний випадок в мережах' });
  });
});

describe('VoeProvider errors', () => {
  const rejecting = () => fakeHttp(Object.fromEntries(
    [ARCHIVE_URL, CHERGA_URL, CHOMU_URL, ...Object.values(IMG)].map((u) => [u, () => new TypeError('fetch failed')]),
  ));

  it('a rejected fetch while offline is a NetworkError', async () => {
    const { p, log } = setup({ http: rejecting(), online: false });
    await expectError(p.fetchSnapshot(KOVEL), NetworkError, OFFLINE);
    expect(log.error).toHaveBeenCalledWith('voe fetchSnapshot failed', expect.any(NetworkError));
  });

  it('a rejected fetch while online means the site does not answer', async () => {
    const { p } = setup({ http: rejecting(), online: true });
    const err = await expectError(p.fetchSnapshot(KOVEL), ProviderError, NO_ANSWER);
    expect(err).not.toBeInstanceOf(NetworkError);
  });

  it('a non-OK status is a site error', async () => {
    const { p } = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => failStatus(500) }) });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, HTTP_ERROR);
  });

  it('a failing image is a site error too', async () => {
    const { p } = setup({ http: fakeHttp({ [IMG.d20]: () => failStatus(404) }) });
    await expectError(p.fetchSnapshot(KOVEL), ProviderError, HTTP_ERROR);
  });

  it('a failure does not break the next call', async () => {
    let fail = true;
    const { p } = setup({ http: fakeHttp({ [ARCHIVE_URL]: () => (fail ? failStatus(503) : okText(JSON.stringify(ARCHIVE))) }) });
    await expect(p.fetchSnapshot(KOVEL)).rejects.toThrow(HTTP_ERROR);
    fail = false;
    await expect(p.fetchSnapshot(KOVEL)).resolves.toMatchObject({ providerId: 'voe' });
  });
});

describe('VoeProvider address lookup', () => {
  it('lists the 300 streets of Ковель, sorted', async () => {
    const { p } = setup();
    const streets = await p.listStreets('м. Ковель');
    expect(streets).toHaveLength(300);
    expect(streets).toEqual([...streets].sort((a, b) => a.localeCompare(b, 'uk')));
    expect(streets).toContain('Незалежності');
  });

  it('lists the houses as the queue table parser does', async () => {
    const { p } = setup();
    const houses = await p.listHouses('м. Ковель', 'Незалежності');
    const rows = parseQueueTable(CHERGA).filter((r) => r.settlement === 'Ковель');
    expect(houses).toEqual(housesOf(rows, 'Незалежності'));
    expect(houses.find((h) => h.house === '25')?.lines.map((l) => l.groupId)).toEqual(['4.2', 'none']);
  });

  it('asks the operator once per city for the run', async () => {
    const { p, http } = setup();
    await p.listStreets('м. Ковель');
    await p.listHouses('м. Ковель', 'Незалежності');
    await p.fetchSnapshot(KOVEL);
    expect(http.count(CHERGA_URL)).toBe(1);
  });

  it('gives an unknown city no streets', async () => {
    const { p, http } = setup();
    await expect(p.listStreets('с. Немаєтакого')).resolves.toEqual([]);
    expect(form(http.calls[0].init).get('formCity')).toBe('Немаєтакого');
  });

  it('throws when the queue lookup fails in the wizard', async () => {
    const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => failStatus(500) }) });
    await expectError(p.listStreets('м. Ковель'), ProviderError, HTTP_ERROR);
  });

  it('lists a street once when the operator writes its apostrophe two ways, with the houses of both rows', async () => {
    const rows = [
      ['Ковельський', 'Ковель', 'Левка Лук’яненка', '1, 2a', '1.1'],
      ['Ковельський', 'Ковель', "Левка Лук'яненка", '2А, 3', '1.2'],
    ];
    const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(rows) }) });
    await expect(p.listStreets('м. Ковель')).resolves.toEqual(['Левка Лук’яненка']);
    const houses = await p.listHouses('м. Ковель', 'Левка Лук’яненка');
    expect(houses.map((h) => h.house)).toEqual(['1', '2А', '3']);
    expect(houses.find((h) => h.house === '2А')?.lines.map((l) => l.groupId)).toEqual(['1.1', '1.2']);
  });

  it('takes a settlement\'s rows whichever apostrophe the operator writes in its name', async () => {
    const rows = [['Камінь-Каширський', "В'язівне", 'Шкільна', '1', '1.1']];
    const { p, http } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(rows) }) });
    await expect(p.listStreets('с. В’язівне')).resolves.toEqual(['Шкільна']);
    // Sent as bundled (U+2019): the live form finds the village with either apostrophe (settlements.source.md).
    expect(form(http.calls[0].init).get('formCity')).toBe('В’язівне');
  });

  it('keeps a unique settlement\'s rows of every district', async () => {
    const rows = [['Ковельський', 'Ковель', 'Незалежності', '1', '1.1'], ['Луцький', 'Ковель', 'Шевченка', '2', '1.2']];
    const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(rows) }) });
    await expect(p.listStreets('м. Ковель')).resolves.toEqual(['Незалежності', 'Шевченка']);
  });

  it('does not keep an empty answer for the run', async () => {
    let page = EMPTY_PAGE;
    const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => okText(page) }) });
    await expect(p.listStreets('м. Ковель')).resolves.toEqual([]);
    page = CHERGA;
    await expect(p.listStreets('м. Ковель')).resolves.toHaveLength(300);
  });

  describe('same-named villages', () => {
    it('filters by the district, matching Latin look-alike letters', async () => {
      const { p, http } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(ZARICHCHIA) }) });
      await expect(p.listStreets('с. Заріччя (Володимирський р-н)')).resolves.toEqual(['Шкільна']);
      await expect(p.listStreets('с. Заріччя (Ковельський р-н)')).resolves.toEqual(['Польова']);
      expect(form(http.calls[0].init).get('formCity')).toBe('Заріччя');
    });

    it('filters by the district when the labels differ only by с. / с-ще', async () => {
      // с. Луків (Луцький) and с-ще Луків (Ковельський): no « (… р-н)» in either label, one name at the operator.
      const rows = [['Луцький', 'Луків', 'Шкільна', '1', '1.1'], ['Ковельський', 'Луків', 'Польова', '2', '2.1']];
      const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(rows) }) });
      await expect(p.listStreets('с. Луків')).resolves.toEqual(['Шкільна']);
      await expect(p.listStreets('с-ще Луків')).resolves.toEqual(['Польова']);
    });

    it('falls back to the name alone when the operator has no row in that district', async () => {
      const rows = ZARICHCHIA.filter((r) => r[0] !== 'Ковельський');
      const { p } = setup({ http: fakeHttp({ [CHERGA_URL]: () => queueTable(rows) }) });
      await expect(p.listStreets('с. Заріччя (Ковельський р-н)')).resolves.toEqual(['Лісова', 'Шкільна']);
    });
  });
});

describe('VoeProvider basics', () => {
  it('is the Volyn provider', () => {
    const { p } = setup();
    expect(p.id).toBe('voe');
    expect(p.displayName).toBe('Волиньобленерго');
  });

  it('lists the bundled settlements without a request', async () => {
    const { p, http } = setup();
    const cities = await p.listCities();
    expect(cities).toEqual(voeSettlements().map((s) => s.label));
    expect(cities).toContain('м. Ковель');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('has nothing to verify or dispose', async () => {
    const { p, http } = setup();
    await expect(p.showVerification()).resolves.toBeUndefined();
    expect(() => p.dispose()).not.toThrow();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('runs one call at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const base = fakeHttp();
    const fetch = vi.fn<HttpFetch>(async (url, init) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await base.fetch(url, init);
      } finally {
        inFlight--;
      }
    });
    const p = new VoeProvider({ fetch, isOnline: () => true, now: () => at('2026-10-20', 10) });
    await Promise.all([p.listStreets('м. Ковель'), p.fetchSnapshot(KOVEL), p.listHouses('м. Ковель', 'Незалежності')]);
    expect(most).toBe(1);
  });
});
