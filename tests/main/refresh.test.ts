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

test('throwing listener does not change outcome or block other listeners', async () => {
  const { svc } = setup(async () => fixtureSnapshot());
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const seen: string[] = [];
  svc.onState(() => { throw new Error('boom'); });
  svc.onState(s => seen.push(s.phase));
  expect(await svc.refresh()).toBe(true);
  expect(svc.getState().phase).toBe('ok');
  expect(seen).toEqual(['refreshing', 'ok']);
  err.mockRestore();
});

function addrFor(house: string) { return { ...addr, house }; }
function snapFor(a: typeof addr) { return { ...fixtureSnapshot(), address: a }; }
function controlled() {
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  const pending: { house: string; resolve(): void }[] = [];
  const provider = {
    fetchSnapshot: vi.fn((a: typeof addr) => new Promise<ScheduleSnapshot>(res => {
      pending.push({ house: a.house, resolve: () => res(snapFor(a)) });
    })),
  } as unknown as ScheduleProvider;
  const svc = new RefreshService({ store, getProvider: () => provider });
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { store, svc, pending, flush };
}

test('setAddress during in-flight refresh for old address → final snapshot is for new address', async () => {
  const { store, svc, pending, flush } = controlled();
  store.updateSettings({ address: addrFor('1') });
  const first = svc.refresh(); await flush();
  const set = svc.setAddress(addrFor('2')); await flush();
  pending[0].resolve(); await flush();
  expect(pending.map(p => p.house)).toEqual(['1', '2']);
  pending[1].resolve(); await set; await first;
  expect(store.getSnapshot()?.address.house).toBe('2');
  expect(svc.getState().phase).toBe('ok');
});

test('two rapid setAddress calls → final snapshot matches last address', async () => {
  const { store, svc, pending, flush } = controlled();
  store.updateSettings({ address: addrFor('1') });
  const first = svc.refresh(); await flush();
  const a = svc.setAddress(addrFor('2')); const b = svc.setAddress(addrFor('3')); await flush();
  pending[0].resolve(); await flush();
  expect(pending.map(p => p.house)).toEqual(['1', '3']);
  pending[1].resolve(); await Promise.all([a, b, first]);
  expect(store.getSnapshot()?.address.house).toBe('3');
});
