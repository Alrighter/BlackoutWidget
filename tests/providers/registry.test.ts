import { createProviders } from '../../src/main/providers/registry';
import { NEUTRALIZE_TIMERS, READY_CHECK, isPagePollRequest } from '../../src/main/providers/dtek/page-scripts';
import { PROVIDERS, providerSiteUrl } from '../../src/shared/providers';
import { silentLogger } from '../../src/main/log';
import type { SessionOptions } from '../../src/main/providers/browser-session';

const HOSTS: Record<string, string> = {
  'dtek-kem': 'dtek-kem.com.ua', 'dtek-dnem': 'dtek-dnem.com.ua', 'dtek-krem': 'dtek-krem.com.ua', 'dtek-oem': 'dtek-oem.com.ua',
};
function setup() {
  const made: SessionOptions[] = [];
  const session = { ensureReady: vi.fn(), evaluate: vi.fn(), showForUser: vi.fn(), dispose: vi.fn(), reload: vi.fn(), isOnline: vi.fn(), isOpen: vi.fn(() => false), release: vi.fn() };
  const http = { fetch: vi.fn(), isOnline: vi.fn(() => true) };
  const providers = createProviders(o => { made.push(o); return session as any; }, silentLogger, http);
  return { made, session, http, providers };
}
test('providers come out in the card order of PROVIDERS', () => {
  const ids = setup().providers.map(p => p.id);
  expect(ids).toEqual(Object.keys(PROVIDERS));
  expect(ids).toEqual(['dtek-kem', 'voe', 'dtek-dnem', 'cek', 'ztoe', 'dtek-krem', 'loe', 'mkoe', 'dtek-oem', 'toe', 'cvoe']);
});
test('DTEK and Volyn do not implement houseLines; Ternopil and Mykolaiv do', () => {
  const providers = setup().providers;
  const old = providers.filter(p => p.id === 'voe' || p.id.startsWith('dtek-'));
  expect(old.map(p => p.id)).toEqual(['dtek-kem', 'voe', 'dtek-dnem', 'dtek-krem', 'dtek-oem']);
  for (const p of old) expect(p.houseLines).toBeUndefined();
  expect(typeof providers.find(p => p.id === 'toe')?.houseLines).toBe('function');
  expect(typeof providers.find(p => p.id === 'mkoe')?.houseLines).toBe('function');
  // Lviv, Zhytomyr, Chernivtsi and CEK list every house's queues with the houses.
  expect(providers.find(p => p.id === 'loe')?.houseLines).toBeUndefined();
  expect(providers.find(p => p.id === 'ztoe')?.houseLines).toBeUndefined();
  expect(providers.find(p => p.id === 'cvoe')?.houseLines).toBeUndefined();
  expect(providers.find(p => p.id === 'cek')?.houseLines).toBeUndefined();
});
test('each DTEK site gets its own url, partition and host', () => {
  const { made, providers } = setup();
  const dtek = providers.filter(p => p.id.startsWith('dtek-'));
  expect(made).toHaveLength(4);
  dtek.forEach((p, i) => {
    expect(made[i]).toEqual({
      url: providerSiteUrl(p.id), partition: `persist:${p.id}`, readyCheck: READY_CHECK,
      allowedHosts: [HOSTS[p.id]], afterReady: NEUTRALIZE_TIMERS, blockRequest: isPagePollRequest,
    });
  });
});
test('creating providers touches no session and makes no request', () => {
  const { session, http } = setup();
  for (const fn of Object.values(session)) expect(fn).not.toHaveBeenCalled();
  expect(http.fetch).not.toHaveBeenCalled();
  expect(http.isOnline).not.toHaveBeenCalled();
});
const MIRROR = (f: string) => `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/${f}.json`;
const YASNO = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';
test.each([
  ['dtek-kem', [YASNO, MIRROR('kyiv')]],
  ['dtek-krem', [MIRROR('kyiv-region')]],
  ['dtek-dnem', [MIRROR('dnipro')]],
  ['dtek-oem', [MIRROR('odesa')]],
])('%s reads its feeds in order', async (id, urls) => {
  const { session, http, providers } = setup();
  http.fetch.mockRejectedValue(new Error('no network'));
  const address = { providerId: id, city: 'c', street: 's', house: '1', lineIndex: 0, groupId: 'GPV1.1' };
  const previous = {
    providerId: id, address, groupId: 'GPV1.1', groupLabel: '1.1', days: [], lines: [],
    fetchedAt: new Date().toISOString(), houseCheckedAt: new Date(Date.now() - 3600_000).toISOString(),
  };
  await providers.find(p => p.id === id)!.fetchSnapshot(address, previous).catch(() => undefined);
  expect(http.fetch.mock.calls.map(c => c[0])).toEqual(urls);
  // The fallback is allowed (no page opened yet): the page is asked after the feeds fail.
  expect(session.ensureReady).toHaveBeenCalled();
});
