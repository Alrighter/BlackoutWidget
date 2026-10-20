import { createProviders } from '../../src/main/providers/registry';
import { NEUTRALIZE_TIMERS, READY_CHECK, isPagePollRequest } from '../../src/main/providers/dtek/page-scripts';
import { providerSiteUrl } from '../../src/shared/providers';
import type { SessionOptions } from '../../src/main/providers/browser-session';

const HOSTS: Record<string, string> = {
  'dtek-kem': 'dtek-kem.com.ua', 'dtek-dnem': 'dtek-dnem.com.ua', 'dtek-krem': 'dtek-krem.com.ua', 'dtek-oem': 'dtek-oem.com.ua',
};
function setup() {
  const made: SessionOptions[] = [];
  const session = { ensureReady: vi.fn(), evaluate: vi.fn(), showForUser: vi.fn(), dispose: vi.fn(), reload: vi.fn(), isOnline: vi.fn() };
  const providers = createProviders(o => { made.push(o); return session as any; });
  return { made, session, providers };
}
test('providers come out in a fixed order', () => {
  expect(setup().providers.map(p => p.id)).toEqual(['dtek-kem', 'dtek-dnem', 'dtek-krem', 'dtek-oem']);
});
test('each DTEK site gets its own url, partition and host', () => {
  const { made, providers } = setup();
  expect(made).toHaveLength(4);
  providers.forEach((p, i) => {
    expect(made[i]).toEqual({
      url: providerSiteUrl(p.id), partition: `persist:${p.id}`, readyCheck: READY_CHECK,
      allowedHosts: [HOSTS[p.id]], afterReady: NEUTRALIZE_TIMERS, blockRequest: isPagePollRequest,
    });
  });
});
test('creating providers touches no session', () => {
  const { session } = setup();
  for (const fn of Object.values(session)) expect(fn).not.toHaveBeenCalled();
});
