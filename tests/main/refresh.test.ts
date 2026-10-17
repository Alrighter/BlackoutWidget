import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../src/main/store';
import { RefreshService } from '../../src/main/refresh';
import { CaptchaRequiredError, ProviderError } from '../../src/main/providers/types';
import type { ScheduleProvider } from '../../src/main/providers/types';
import type { ScheduleSnapshot } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const addr = fixtureSnapshot().address;
function setup(fetch: () => Promise<ScheduleSnapshot>, opts: { cached?: ScheduleSnapshot } = {}) {
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  store.updateSettings({ address: addr }); if (opts.cached) store.setSnapshot(opts.cached);
  const provider = { fetchSnapshot: vi.fn(fetch) } as unknown as ScheduleProvider;
  return { store, provider, svc: new RefreshService({ store, getProvider: () => provider }) };
}
test('starts with cached snapshot before any refresh (offline start)', () => {
  const { svc } = setup(async () => { throw new Error('offline'); }, { cached: fixtureSnapshot() });
  expect(svc.getState().snapshot?.sourceUpdatedAt).toBe('17.10.2026 11:55');
});
test('successful refresh saves snapshot, phase ok, emits', async () => {
  const { svc, store } = setup(async () => fixtureSnapshot());
  const seen: string[] = []; svc.onState(s => seen.push(s.phase));
  expect(await svc.refresh()).toBe(true);
  expect(seen).toEqual(['refreshing', 'ok']); expect(store.getSnapshot()).not.toBeNull();
});
test('new sourceUpdatedAt replaces snapshot and emits', async () => {
  let n = 0; const { svc } = setup(async () => fixtureSnapshot({ sourceUpdatedAt: n++ ? '17.10.2026 14:00' : '17.10.2026 11:55' }));
  await svc.refresh(); await svc.refresh();
  expect(svc.getState().snapshot?.sourceUpdatedAt).toBe('17.10.2026 14:00');
});
test('provider error keeps previous snapshot', async () => {
  const { svc } = setup(async () => { throw new ProviderError('Сайт ДТЕК повернув помилку'); }, { cached: fixtureSnapshot() });
  expect(await svc.refresh()).toBe(false);
  expect(svc.getState()).toMatchObject({ phase: 'error', lastError: 'Сайт ДТЕК повернув помилку' });
  expect(svc.getState().snapshot).not.toBeNull();
});
test('captcha → phase captcha', async () => {
  const { svc } = setup(async () => { throw new CaptchaRequiredError('x'); });
  await svc.refresh(); expect(svc.getState().phase).toBe('captcha');
});
test('lineChanged when group under lineIndex differs or line vanished', async () => {
  const swapped = { ...fixtureSnapshot(), lines: [{ index: 1, groupId: 'GPV3.1', label: 'Черга 3.1' }] };
  const a = setup(async () => swapped); await a.svc.refresh(); expect(a.svc.getState().lineChanged).toBe(true);
  const b = setup(async () => ({ ...fixtureSnapshot(), lines: [] })); await b.svc.refresh(); expect(b.svc.getState().lineChanged).toBe(true);
  const c = setup(async () => fixtureSnapshot()); await c.svc.refresh(); expect(c.svc.getState().lineChanged).toBe(false);
});
test('no address → no provider call, returns true, phase idle', async () => {
  const { svc, store, provider } = setup(async () => fixtureSnapshot());
  store.updateSettings({ address: null });
  expect(await svc.refresh()).toBe(true); expect(provider.fetchSnapshot).not.toHaveBeenCalled();
  expect(svc.getState().phase).toBe('idle');
});
