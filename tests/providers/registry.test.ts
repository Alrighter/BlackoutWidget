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
  const session = { ensureReady: vi.fn(), evaluate: vi.fn(), showForUser: vi.fn(), dispose: vi.fn(), reload: vi.fn(), isOnline: vi.fn() };
  const http = { fetch: vi.fn(), isOnline: vi.fn(() => true) };
  const providers = createProviders(o => { made.push(o); return session as any; }, silentLogger, http);
  return { made, session, http, providers };
}
test('providers come out in the card order of PROVIDERS', () => {
  const ids = setup().providers.map(p => p.id);
  expect(ids).toEqual(Object.keys(PROVIDERS));
  expect(ids).toEqual(['dtek-kem', 'voe', 'dtek-dnem', 'ztoe', 'dtek-krem', 'loe', 'mkoe', 'dtek-oem', 'toe', 'cvoe']);
});
test('DTEK and Volyn do not implement houseLines; Ternopil and Mykolaiv do', () => {
  const providers = setup().providers;
  const old = providers.filter(p => p.id === 'voe' || p.id.startsWith('dtek-'));
  expect(old.map(p => p.id)).toEqual(['dtek-kem', 'voe', 'dtek-dnem', 'dtek-krem', 'dtek-oem']);
  for (const p of old) expect(p.houseLines).toBeUndefined();
  expect(typeof providers.find(p => p.id === 'toe')?.houseLines).toBe('function');
  expect(typeof providers.find(p => p.id === 'mkoe')?.houseLines).toBe('function');
  // Lviv, Zhytomyr and Chernivtsi list every house's queues with the houses.
  expect(providers.find(p => p.id === 'loe')?.houseLines).toBeUndefined();
  expect(providers.find(p => p.id === 'ztoe')?.houseLines).toBeUndefined();
  expect(providers.find(p => p.id === 'cvoe')?.houseLines).toBeUndefined();
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
