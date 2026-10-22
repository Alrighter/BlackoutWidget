import stale from '../fixtures/dtek/getHomeNum-stale-updateFact.json';
import fresh from '../fixtures/dtek/getHomeNum-fresh.json';
import { DtekProvider } from '../../src/main/providers/dtek';
import { READ_FACT, getHomeNumScript, isPagePollRequest, readStreetsScript } from '../../src/main/providers/dtek/page-scripts';
import { CaptchaRequiredError, NetworkError, ProviderError } from '../../src/main/providers/types';
import { factToDays, DTEK_QUIET_NOTE } from '../../src/main/providers/dtek/parse';
import { AppStore } from '../../src/main/store';
import { RefreshService } from '../../src/main/refresh';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const KREM = { id: 'dtek-krem', cityLevel: true };
const KEM = { id: 'dtek-kem', cityLevel: false };
const C = 'м. Біла Церква', S = 'бул. Грушевського Михайла';
const addr = { providerId: 'dtek-krem', city: C, street: S, house: '40', lineIndex: 1, groupId: 'GPV1.2' };
// The fixture is the live capture of 17.10.2026: keep "today" on that day so it is not a quiet day.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-17T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });
const oldFact = { ...stale.fact, update: '17.10.2026 09:40' };
function fakeSession(replies: Record<string, unknown[]>) {
  return {
    ensureReady: vi.fn(async () => {}), showForUser: vi.fn(async () => {}), dispose: vi.fn(), reload: vi.fn(async () => {}), isOnline: vi.fn(() => true),
    isOpen: vi.fn(() => true), release: vi.fn(),
    evaluate: vi.fn(async (js: string) => { const q = replies[js]; if (!q?.length) throw new Error('unexpected ' + js.slice(0, 60)); return q.shift(); }) };
}
test('first fetch sends cached updateFact and adopts fresh fact', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: oldFact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 09:40')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const snap = await new DtekProvider(KREM, s as any).fetchSnapshot(addr);
  expect(snap.sourceUpdatedAt).toBe('17.10.2026 11:55');
  expect(snap.groupId).toBe('GPV1.2'); expect(snap.groupLabel).toBe('Черга 1.2');
  expect(snap.days.map(d => d.date)).toEqual(['2026-10-17']);
  expect(snap.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
});
test('second fetch reuses cached fact when response has none', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }, { status: 200, body: JSON.stringify(fresh) }] });
  const p = new DtekProvider(KREM, s as any);
  await p.fetchSnapshot(addr);
  const snap = await p.fetchSnapshot(addr);
  expect(snap.days[0].slots[12]).toBe('off');
});
test('non-200 → reload and retry once, then ProviderError', async () => {
  const bad = { status: 403, body: '<html>' };
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }, { fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [bad, bad] });
  await expect(new DtekProvider(KREM, s as any).fetchSnapshot(addr)).rejects.toThrow(ProviderError);
  expect(s.reload).toHaveBeenCalledTimes(1);
  expect(s.evaluate.mock.calls.filter(c => c[0] === READ_FACT)).toHaveLength(2);
});
test('house missing → ProviderError', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  await expect(new DtekProvider(KREM, s as any).fetchSnapshot({ ...addr, house: '999' })).rejects.toThrow(/Будинок не знайдено/);
});
test('captcha propagates', async () => {
  const s = fakeSession({}); s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  await expect(new DtekProvider(KREM, s as any).fetchSnapshot(addr)).rejects.toBeInstanceOf(CaptchaRequiredError);
});
test('listHouses parses lines', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const houses = await new DtekProvider(KREM, s as any).listHouses(C, S);
  expect(houses.find(h => h.house === '40')!.lines).toHaveLength(2);
});
test('unexpected parse exception is wrapped in ProviderError', async () => {
  const broken = { result: true, data: { '40': { sub_type_reason: 5 } } };
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(broken) }] });
  await expect(new DtekProvider(KREM, s as any).fetchSnapshot(addr)).rejects.toBeInstanceOf(ProviderError);
});
test('concurrent fetches never overlap evaluate calls', async () => {
  const script = getHomeNumScript(C, S, '17.10.2026 11:55');
  let active = 0, maxActive = 0, homeNumCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const s = fakeSession({});
  s.evaluate.mockImplementation((async (js: string) => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (js === READ_FACT) return { fact: stale.fact, schNames: stale.preset.sch_names };
      if (js === script) { homeNumCalls++; if (homeNumCalls === 1) await gate; return { status: 200, body: JSON.stringify(stale) }; }
      throw new Error('unexpected');
    } finally { active--; }
  }) as any);
  const p = new DtekProvider(KREM, s as any);
  const a = p.fetchSnapshot(addr), b = p.fetchSnapshot(addr);
  await new Promise(r => setTimeout(r, 20));
  expect(homeNumCalls).toBe(1); // second waits for the first
  release();
  await Promise.all([a, b]);
  expect(homeNumCalls).toBe(2);
  expect(maxActive).toBe(1);
});
test('page script reports in-page failures as status 0', () => {
  expect(getHomeNumScript(C, S, 'x')).toContain("status: 0");
});

const factReply = () => ({ fact: stale.fact, schNames: stale.preset.sch_names });
const homeNum = getHomeNumScript(C, S, '17.10.2026 11:55');
test('status 0 on both attempts while online (DTEK slow / reset) → plain ProviderError, not offline', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply(), factReply()], [homeNum]: [{ status: 0, body: '' }, { status: 0, body: '' }] });
  const err = await new DtekProvider(KREM, s as any).fetchSnapshot(addr).catch(e => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).not.toBeInstanceOf(NetworkError);
  expect(err.message).toBe('Сайт ДТЕК не відповідає');
  expect(s.reload).toHaveBeenCalledTimes(1);
});
test('status 0 on both attempts while offline → NetworkError with the offline message', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply(), factReply()], [homeNum]: [{ status: 0, body: '' }, { status: 0, body: '' }] });
  s.isOnline.mockReturnValue(false);
  const err = await new DtekProvider(KREM, s as any).fetchSnapshot(addr).catch(e => e);
  expect(err).toBeInstanceOf(NetworkError);
  expect(err.message).toBe('Немає з’єднання з сайтом ДТЕК');
});
test('status 0 then 403 → plain ProviderError (the site answered)', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply(), factReply()], [homeNum]: [{ status: 0, body: '' }, { status: 403, body: '<html>' }] });
  const err = await new DtekProvider(KREM, s as any).fetchSnapshot(addr).catch(e => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).not.toBeInstanceOf(NetworkError);
});
test('NetworkError from the session passes through unchanged', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 0, body: '' }] });
  const offline = new NetworkError('Немає з’єднання з сайтом ДТЕК');
  s.reload.mockRejectedValue(offline);
  await expect(new DtekProvider(KREM, s as any).fetchSnapshot(addr)).rejects.toBe(offline);
});

function fakeLog() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }
test('logs the raw house entry when outage fields are filled, and each unknown hour status once', async () => {
  const body = structuredClone(stale) as any;
  const ts = Object.keys(body.fact.data)[0];
  Object.assign(body.fact.data[ts]['GPV1.2'], { '1': 'weird', '2': 'weird', '3': 'odd' });
  body.data['40'] = { ...body.data['40'], type: 'Аварійне відключення', end_date: '17:00 17.10.2026' };
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(body) }] });
  const log = fakeLog();
  await new DtekProvider(KREM, s as any, log).fetchSnapshot(addr);
  expect(log.info).toHaveBeenCalledWith('dtek-krem: outage fields for house', { house: '40', entry: body.data['40'] });
  expect(log.warn.mock.calls).toEqual([
    ['dtek-krem: unknown hour status', { groupId: 'GPV1.2', status: 'weird' }],
    ['dtek-krem: unknown hour status', { groupId: 'GPV1.2', status: 'odd' }],
  ]);
});
test('quiet house entry is not logged; provider errors are logged with their cause', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(stale) }] });
  const log = fakeLog();
  const p = new DtekProvider(KREM, s as any, log);
  await p.fetchSnapshot(addr);
  expect(log.info).not.toHaveBeenCalled();
  s.evaluate.mockRejectedValueOnce(new TypeError('boom'));
  await expect(p.fetchSnapshot(addr)).rejects.toBeInstanceOf(ProviderError);
  expect(log.error).toHaveBeenCalledTimes(1);
  const [msg, err] = log.error.mock.calls[0];
  expect(msg).toBe('dtek-krem fetchSnapshot failed');
  expect(err.cause).toBeInstanceOf(TypeError);
});

/** Runs the real page script with a fake fetch and returns the form body it would POST. */
async function bodyOf(script: string): Promise<string> {
  let body = '';
  const fetch = async (_url: string, init: { body: string }) => { body = init.body; return { status: 200, text: async () => '{}' }; };
  const document = { querySelector: () => null };
  await new Function('fetch', 'document', `return ${script}`)(fetch, document);
  return body;
}
test('page-poll filter blocks the page\'s own polling but never our getHomeNum', async () => {
  const url = 'https://www.dtek-krem.com.ua/ua/ajax';
  const ours = await bodyOf(getHomeNumScript(C, S, '17.10.2026 11:55'));
  expect(ours).toContain('method=getHomeNum');
  expect(isPagePollRequest({ method: 'POST', url, body: ours })).toBe(false);
  expect(isPagePollRequest({ method: 'POST', url, body: 'method=checkDisconUpdate&update=17.10.2026+11%3A55' })).toBe(true);
  expect(isPagePollRequest({ method: 'POST', url, body: 'method=getStreetsInvisibly' })).toBe(true);
  expect(isPagePollRequest({ method: 'GET', url, body: null })).toBe(false);
  expect(isPagePollRequest({ method: 'POST', url: 'https://www.dtek-krem.com.ua/ua/other', body: 'method=checkDisconUpdate' })).toBe(false);
  expect(isPagePollRequest({ method: 'POST', url, body: null })).toBe(false);
});

// Synthetic copies of the captured response, shaped like the live sample of 2026-10-17 (stabilization outage, house 40).
const SUB = 'Стабілізаційне відключення (Згідно графіку погодинних відключень)';
function withHouse40(patch: Record<string, unknown>) {
  const body = structuredClone(stale) as any;
  body.data['40'] = { ...body.data['40'], ...patch };
  return body;
}
const line2 = { ...addr, lineIndex: 2, groupId: 'GPV4.2' };
async function viaService(body: unknown, address: typeof addr) {
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(body) }] });
  const provider = new DtekProvider(KREM, s as any);
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  const { id } = store.addLocation({ name: 'Дім', address, widgetStyle: 'compact', widgetPosition: null });
  const svc = new RefreshService({ store, getProvider: () => provider });
  expect(await svc.refresh(id)).toBe('ok');
  return svc.getStates()[0];
}
test('active outage listing only GPV1.2: a Лінія 2 / GPV4.2 address keeps the GPV4.2 schedule and gets no line warning', async () => {
  const body = withHouse40({ type: '2', sub_type: SUB, start_date: '15:11 17.10.2026', end_date: '19:00 17.10.2026', sub_type_reason: ['GPV1.2'] });
  const state = await viaService(body, line2);
  const snap = state.snapshot!;
  expect(snap).toMatchObject({ groupId: 'GPV4.2', groupLabel: 'Черга 4.2', outageActive: true, lines: [{ index: 1, groupId: 'GPV1.2' }] });
  expect(snap.days).toEqual(factToDays(stale.fact as any, 'GPV4.2'));
  expect(snap.currentOutage).toEqual({ kind: 'other', text: SUB, start: '15:11 17.10.2026', end: '19:00 17.10.2026', groups: ['GPV1.2'] });
  expect(state.lineChanged).toBe(false);
});
test('no outage reported and GPV4.2 no longer listed: line warning, schedule still from the saved GPV4.2', async () => {
  const state = await viaService(withHouse40({ sub_type_reason: ['GPV1.2'] }), line2);
  expect(state.snapshot).toMatchObject({ groupId: 'GPV4.2', outageActive: false });
  expect(state.snapshot!.days).toEqual(factToDays(stale.fact as any, 'GPV4.2'));
  expect(state.lineChanged).toBe(true);
});
test('a Лінія 1 address keeps its own queue even when the outage lists another one first', async () => {
  const body = withHouse40({ type: '2', sub_type: SUB, sub_type_reason: ['GPV4.2'] });
  const state = await viaService(body, addr);
  expect(state.snapshot).toMatchObject({ groupId: 'GPV1.2', groupLabel: 'Черга 1.2' });
  expect(state.snapshot!.days[0].slots[12]).toBe('off');
  expect(state.lineChanged).toBe(false);
});
test('queue label falls back to «Черга X.Y» when the source has no name for it', async () => {
  const body = withHouse40({}) as any;
  delete body.preset.sch_names['GPV4.2'];
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(body) }] });
  expect((await new DtekProvider(KREM, s as any).fetchSnapshot(line2)).groupLabel).toBe('Черга 4.2');
});

test('a site without a city level lists its single city without touching the session', async () => {
  const s = fakeSession({});
  expect(await new DtekProvider(KEM, s as any).listCities()).toEqual(['м. Київ']);
  expect(s.ensureReady).not.toHaveBeenCalled();
  expect(s.evaluate).not.toHaveBeenCalled();
});
test('Kyiv listStreets reads the flat streets array', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply()], [readStreetsScript(null)]: [['вул. Хрещатик']] });
  expect(await new DtekProvider(KEM, s as any).listStreets('м. Київ')).toEqual(['вул. Хрещатик']);
  expect(s.ensureReady).toHaveBeenCalled();
});
test('a site with a city level passes the city into the streets script', async () => {
  // Dnipro, Odesa and Kyiv oblast: without the city the wizard would list no streets there.
  const s = fakeSession({ [READ_FACT]: [factReply()], [readStreetsScript(C)]: [[S]] });
  expect(await new DtekProvider(KREM, s as any).listStreets(C)).toEqual([S]);
  expect(s.evaluate).toHaveBeenCalledWith(readStreetsScript(C));
  expect(readStreetsScript(C)).not.toBe(readStreetsScript(null));
});
test('Kyiv listHouses sends no city field', async () => {
  const script = getHomeNumScript(null, 'вул. Хрещатик', '17.10.2026 11:55');
  const s = fakeSession({ [READ_FACT]: [factReply()], [script]: [{ status: 200, body: JSON.stringify(stale) }] });
  const houses = await new DtekProvider(KEM, s as any).listHouses('м. Київ', 'вул. Хрещатик');
  expect(houses.length).toBeGreaterThan(0);
  expect(script).not.toContain("'city'");
  expect(await bodyOf(script)).not.toContain('city');
});
test('getHomeNumScript keeps the city field when the site has a city level', async () => {
  expect(getHomeNumScript('м. Буча', 'вул. Х', 'u')).toContain("'city'");
  expect(getHomeNumScript(null, 'вул. Хрещатик', 'u')).not.toContain("'city'");
});
test('a failure is logged under the provider id', async () => {
  const s = fakeSession({}); s.ensureReady.mockRejectedValue(new Error('x'));
  const log = fakeLog();
  await expect(new DtekProvider(KEM, s as any, log).fetchSnapshot({ ...addr, providerId: 'dtek-kem' })).rejects.toBeInstanceOf(ProviderError);
  expect(log.error.mock.calls[0][0]).toBe('dtek-kem fetchSnapshot failed');
});

describe('quiet day (no schedule published for today)', () => {
  const tsOf = (iso: string) => String(Date.parse(iso) / 1000);
  const hours = (status: string) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), status]));
  const bodyWith = (data: Record<string, unknown> | unknown[]) => {
    const body = structuredClone(stale) as any;
    body.fact = { ...body.fact, data };
    return body;
  };
  async function snapshotFor(data: Record<string, unknown> | unknown[]) {
    const body = bodyWith(data);
    const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(body) }] });
    return new DtekProvider(KREM, s as any).fetchSnapshot(addr);
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T07:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  test('empty fact.data: today is all on, with the note', async () => {
    const snap = await snapshotFor({});
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: Array(48).fill('on') }]);
    expect(snap.note).toBe(DTEK_QUIET_NOTE);
  });
  test('fact.data as an empty array (the live quiet shape): today is all on, with the note', async () => {
    const snap = await snapshotFor([]);
    expect(snap.days).toEqual([{ date: '2026-10-20', slots: Array(48).fill('on') }]);
    expect(snap.note).toBe(DTEK_QUIET_NOTE);
    expect(snap.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
  });
  test('only tomorrow published: today all on with the note, tomorrow kept', async () => {
    const snap = await snapshotFor({ [tsOf('2026-10-21T09:00:00Z')]: { 'GPV1.2': hours('no') } });
    expect(snap.days.map(d => d.date)).toEqual(['2026-10-20', '2026-10-21']);
    expect(snap.days[0].slots).toEqual(Array(48).fill('on'));
    expect(snap.days[1].slots).toEqual(Array(48).fill('off'));
    expect(snap.note).toBe(DTEK_QUIET_NOTE);
  });
  test('today published for other groups only: no note and no day for today', async () => {
    const snap = await snapshotFor({ [tsOf('2026-10-20T09:00:00Z')]: { 'GPV9.9': hours('no') } });
    expect(snap.days).toEqual([]);
    expect('note' in snap).toBe(false);
  });
  test('today published for the saved group: no note', async () => {
    const snap = await snapshotFor({ [tsOf('2026-10-20T09:00:00Z')]: { 'GPV1.2': hours('yes') } });
    expect(snap.days.map(d => d.date)).toEqual(['2026-10-20']);
    expect('note' in snap).toBe(false);
  });
});
