import stale from '../fixtures/dtek-krem/getHomeNum-stale-updateFact.json';
import fresh from '../fixtures/dtek-krem/getHomeNum-fresh.json';
import { DtekKremProvider } from '../../src/main/providers/dtek-krem';
import { READ_FACT, getHomeNumScript, isPagePollRequest } from '../../src/main/providers/dtek-krem/page-scripts';
import { CaptchaRequiredError, NetworkError, ProviderError } from '../../src/main/providers/types';
const C = 'м. Біла Церква', S = 'бул. Грушевського Михайла';
const addr = { providerId: 'dtek-krem', city: C, street: S, house: '40', lineIndex: 1, groupId: 'GPV1.2' };
const oldFact = { ...stale.fact, update: '17.10.2026 09:40' };
function fakeSession(replies: Record<string, unknown[]>) {
  return {
    ensureReady: vi.fn(async () => {}), showForUser: vi.fn(async () => {}), dispose: vi.fn(), reload: vi.fn(async () => {}),
    evaluate: vi.fn(async (js: string) => { const q = replies[js]; if (!q?.length) throw new Error('unexpected ' + js.slice(0, 60)); return q.shift(); }) };
}
test('first fetch sends cached updateFact and adopts fresh fact', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: oldFact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 09:40')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const snap = await new DtekKremProvider(s as any).fetchSnapshot(addr);
  expect(snap.sourceUpdatedAt).toBe('17.10.2026 11:55');
  expect(snap.groupId).toBe('GPV1.2'); expect(snap.groupLabel).toBe('Черга 1.2');
  expect(snap.days.map(d => d.date)).toEqual(['2026-10-17']);
  expect(snap.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
});
test('second fetch reuses cached fact when response has none', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }, { status: 200, body: JSON.stringify(fresh) }] });
  const p = new DtekKremProvider(s as any);
  await p.fetchSnapshot(addr);
  const snap = await p.fetchSnapshot(addr);
  expect(snap.days[0].slots[12]).toBe('off');
});
test('non-200 → reload and retry once, then ProviderError', async () => {
  const bad = { status: 403, body: '<html>' };
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }, { fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [bad, bad] });
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toThrow(ProviderError);
  expect(s.reload).toHaveBeenCalledTimes(1);
  expect(s.evaluate.mock.calls.filter(c => c[0] === READ_FACT)).toHaveLength(2);
});
test('house missing → ProviderError', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  await expect(new DtekKremProvider(s as any).fetchSnapshot({ ...addr, house: '999' })).rejects.toThrow(/Будинок не знайдено/);
});
test('captcha propagates', async () => {
  const s = fakeSession({}); s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toBeInstanceOf(CaptchaRequiredError);
});
test('listHouses parses lines', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const houses = await new DtekKremProvider(s as any).listHouses(C, S);
  expect(houses.find(h => h.house === '40')!.lines).toHaveLength(2);
});
test('unexpected parse exception is wrapped in ProviderError', async () => {
  const broken = { result: true, data: { '40': { sub_type_reason: 5 } } };
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(broken) }] });
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toBeInstanceOf(ProviderError);
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
  const p = new DtekKremProvider(s as any);
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
test('status 0 on both attempts (in-page fetch failed) → NetworkError with the offline message', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply(), factReply()], [homeNum]: [{ status: 0, body: '' }, { status: 0, body: '' }] });
  const err = await new DtekKremProvider(s as any).fetchSnapshot(addr).catch(e => e);
  expect(err).toBeInstanceOf(NetworkError);
  expect(err.message).toBe('Немає з’єднання з сайтом ДТЕК');
  expect(s.reload).toHaveBeenCalledTimes(1);
});
test('status 0 then 403 → plain ProviderError (the site answered)', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply(), factReply()], [homeNum]: [{ status: 0, body: '' }, { status: 403, body: '<html>' }] });
  const err = await new DtekKremProvider(s as any).fetchSnapshot(addr).catch(e => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).not.toBeInstanceOf(NetworkError);
});
test('NetworkError from the session passes through unchanged', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 0, body: '' }] });
  const offline = new NetworkError('Немає з’єднання з сайтом ДТЕК');
  s.reload.mockRejectedValue(offline);
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toBe(offline);
});

function fakeLog() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }
test('logs the raw house entry when outage fields are filled, and each unknown hour status once', async () => {
  const body = structuredClone(stale) as any;
  const ts = Object.keys(body.fact.data)[0];
  Object.assign(body.fact.data[ts]['GPV1.2'], { '1': 'weird', '2': 'weird', '3': 'odd' });
  body.data['40'] = { ...body.data['40'], type: 'Аварійне відключення', end_date: '17:00 17.10.2026' };
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(body) }] });
  const log = fakeLog();
  await new DtekKremProvider(s as any, log).fetchSnapshot(addr);
  expect(log.info).toHaveBeenCalledWith('dtek-krem: outage fields for house', { house: '40', entry: body.data['40'] });
  expect(log.warn.mock.calls).toEqual([
    ['dtek-krem: unknown hour status', { groupId: 'GPV1.2', status: 'weird' }],
    ['dtek-krem: unknown hour status', { groupId: 'GPV1.2', status: 'odd' }],
  ]);
});
test('quiet house entry is not logged; provider errors are logged with their cause', async () => {
  const s = fakeSession({ [READ_FACT]: [factReply()], [homeNum]: [{ status: 200, body: JSON.stringify(stale) }] });
  const log = fakeLog();
  const p = new DtekKremProvider(s as any, log);
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
