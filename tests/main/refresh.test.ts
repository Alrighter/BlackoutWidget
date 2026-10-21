import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../src/main/store';
import { RefreshService } from '../../src/main/refresh';
import { CaptchaRequiredError, NetworkError, ProviderError } from '../../src/main/providers/types';
import type { ScheduleProvider } from '../../src/main/providers/types';
import type { Address, ScheduleSnapshot } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const addr = fixtureSnapshot().address;
const newStore = () => new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
const place = (store: AppStore, name: string, address: Address | null = addr) =>
  store.addLocation({ name, address: address as Address, widgetStyle: 'compact', widgetPosition: null });

function setup(fetch: () => Promise<ScheduleSnapshot>, opts: { cached?: ScheduleSnapshot } = {}) {
  const store = newStore();
  const loc = place(store, 'Дім');
  const second = place(store, 'Дача'); // same address, never refreshed: must stay untouched
  if (opts.cached) store.setSnapshot(loc.id, opts.cached);
  const provider = { fetchSnapshot: vi.fn(fetch) } as unknown as ScheduleProvider;
  const svc = new RefreshService({ store, getProvider: () => provider });
  return { store, provider, svc, id: loc.id, otherId: second.id, state: () => svc.getStates()[0], other: () => svc.getStates()[1] };
}
test('starts with cached snapshot before any refresh (offline start)', () => {
  const { state } = setup(async () => { throw new Error('offline'); }, { cached: fixtureSnapshot() });
  expect(state().snapshot?.sourceUpdatedAt).toBe('17.10.2026 11:55');
});
test('a snapshot cached for A is not shown for B, even with the same address', () => {
  const { other, state } = setup(async () => fixtureSnapshot(), { cached: fixtureSnapshot() });
  expect(state().snapshot).not.toBeNull();
  expect(other().snapshot).toBeNull();
});
test('successful refresh saves snapshot, phase ok, emits', async () => {
  const { svc, store, id, otherId, state, other } = setup(async () => fixtureSnapshot());
  const seen: string[] = []; svc.onState(() => seen.push(state().phase));
  expect(await svc.refresh(id)).toBe('ok');
  expect(seen).toEqual(['refreshing', 'ok']); expect(store.getSnapshot(id)).not.toBeNull();
  expect(store.getSnapshot(otherId)).toBeNull(); expect(other()).toMatchObject({ phase: 'idle', snapshot: null });
});
test('new sourceUpdatedAt replaces snapshot and emits', async () => {
  let n = 0; const { svc, id, state } = setup(async () => fixtureSnapshot({ sourceUpdatedAt: n++ ? '17.10.2026 14:00' : '17.10.2026 11:55' }));
  await svc.refresh(id); await svc.refresh(id);
  expect(state().snapshot?.sourceUpdatedAt).toBe('17.10.2026 14:00');
});
test('provider error keeps previous snapshot', async () => {
  const { svc, id, state, other } = setup(async () => { throw new ProviderError('Сайт ДТЕК повернув помилку'); }, { cached: fixtureSnapshot() });
  expect(await svc.refresh(id)).toBe('failed');
  expect(other()).toMatchObject({ phase: 'idle', snapshot: null }); expect(other().lastError).toBeUndefined();
  expect(state()).toMatchObject({ phase: 'error', lastError: 'Сайт ДТЕК повернув помилку' });
  expect(state().snapshot).not.toBeNull();
});
test('captcha → phase captcha, outcome failed (it reached the site)', async () => {
  const { svc, id, state, other } = setup(async () => { throw new CaptchaRequiredError('x'); });
  expect(await svc.refresh(id)).toBe('failed'); expect(state().phase).toBe('captcha'); expect(other().phase).toBe('idle');
});
test('NetworkError → outcome offline, phase error with the offline message', async () => {
  const { svc, id, state } = setup(async () => { throw new NetworkError('Немає з’єднання з сайтом ДТЕК'); }, { cached: fixtureSnapshot() });
  expect(await svc.refresh(id)).toBe('offline');
  expect(state()).toMatchObject({ phase: 'error', lastError: 'Немає з’єднання з сайтом ДТЕК' });
  expect(state().snapshot).not.toBeNull();
});
test('a stored snapshot for a different address is never returned', () => {
  const other = { ...fixtureSnapshot(), address: { ...addr, house: '13' } };
  const { svc, store, id, state } = setup(async () => fixtureSnapshot(), { cached: other });
  expect(store.getSnapshot(id)?.address.house).toBe('13');
  expect(state()).toMatchObject({ snapshot: null, lineChanged: false });
  store.updateLocation(id, l => ({ ...l, address: { ...addr, lineIndex: 2, groupId: 'GPV4.2' } }));
  store.setSnapshot(id, fixtureSnapshot());
  expect(svc.getStates()[0].snapshot).toBeNull(); // same house, other line
});
test('lineChanged when group under lineIndex differs or line vanished', async () => {
  const swapped = { ...fixtureSnapshot(), lines: [{ index: 1, groupId: 'GPV3.1', label: 'Черга 3.1' }] };
  const a = setup(async () => swapped); await a.svc.refresh(a.id); expect(a.state().lineChanged).toBe(true);
  const b = setup(async () => ({ ...fixtureSnapshot(), lines: [] })); await b.svc.refresh(b.id); expect(b.state().lineChanged).toBe(true);
  const c = setup(async () => fixtureSnapshot()); await c.svc.refresh(c.id); expect(c.state().lineChanged).toBe(false);
});
test('unknown id → no provider call, returns ok, no emit', async () => {
  const { svc, provider } = setup(async () => fixtureSnapshot());
  const seen: number[] = []; svc.onState(() => seen.push(1));
  expect(await svc.refresh('nope')).toBe('ok'); expect(provider.fetchSnapshot).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
});
test('getStates follows the settings order and never sets actual', () => {
  const store = newStore();
  const a = place(store, 'А'); const b = place(store, 'Б');
  const svc = new RefreshService({ store, getProvider: () => ({}) as ScheduleProvider });
  expect(svc.getStates().map(s => s.location.id)).toEqual([a.id, b.id]);
  expect(svc.getStates().every(s => s.phase === 'idle' && !('actual' in s))).toBe(true);
});

test('throwing listener does not change outcome or block other listeners', async () => {
  const { svc, id, state } = setup(async () => fixtureSnapshot());
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const seen: string[] = [];
  svc.onState(() => { throw new Error('boom'); });
  svc.onState(() => seen.push(state().phase));
  expect(await svc.refresh(id)).toBe('ok');
  expect(state().phase).toBe('ok');
  expect(seen).toEqual(['refreshing', 'ok']);
  err.mockRestore();
});

function addrFor(house: string) { return { ...addr, house }; }
function snapFor(a: typeof addr) { return { ...fixtureSnapshot(), address: a }; }
function controlled() {
  const store = newStore();
  const pending: { house: string; resolve(): void }[] = [];
  const provider = {
    fetchSnapshot: vi.fn((a: typeof addr) => new Promise<ScheduleSnapshot>(res => {
      pending.push({ house: a.house, resolve: () => res(snapFor(a)) });
    })),
  } as unknown as ScheduleProvider;
  const svc = new RefreshService({ store, getProvider: () => provider });
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { store, svc, pending, provider, flush };
}
const rehouse = (store: AppStore, id: string, house: string) => store.updateLocation(id, l => ({ ...l, address: addrFor(house) }));

test('addressChanged during in-flight refresh for old address → final snapshot is for new address', async () => {
  const { store, svc, pending, provider, flush } = controlled();
  const { id } = place(store, 'А', addrFor('1'));
  const first = svc.refresh(id); await flush();
  rehouse(store, id, '2');
  const set = svc.addressChanged(id); await flush();
  pending[0].resolve(); await flush();
  expect(pending.map(p => p.house)).toEqual(['1', '2']);
  expect(provider.fetchSnapshot).toHaveBeenCalledTimes(2);
  pending[1].resolve(); await set; await first;
  expect(store.getSnapshot(id)?.address.house).toBe('2');
  expect(svc.getStates()[0].phase).toBe('ok');
});

test('two rapid address changes → final snapshot matches last address', async () => {
  const { store, svc, pending, flush } = controlled();
  const { id } = place(store, 'А', addrFor('1'));
  const first = svc.refresh(id); await flush();
  rehouse(store, id, '2'); const a = svc.addressChanged(id);
  rehouse(store, id, '3'); const b = svc.addressChanged(id); await flush();
  pending[0].resolve(); await flush();
  expect(pending.map(p => p.house)).toEqual(['1', '3']);
  pending[1].resolve(); await Promise.all([a, b, first]);
  expect(store.getSnapshot(id)?.address.house).toBe('3');
});

test('one location refreshes once at a time', async () => {
  const { store, svc, pending, provider, flush } = controlled();
  const { id } = place(store, 'А', addrFor('1'));
  const a = svc.refresh(id); const b = svc.refresh(id); await flush();
  expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
  pending[0].resolve(); await Promise.all([a, b]);
});

test("one location's failure leaves the other alone", async () => {
  const store = newStore();
  const a = place(store, 'А', addrFor('1')); const b = place(store, 'Б', addrFor('2'));
  const provider = { fetchSnapshot: vi.fn(async (x: Address) => { if (x.house === '1') throw new ProviderError('boom'); return snapFor(x); }) } as unknown as ScheduleProvider;
  const svc = new RefreshService({ store, getProvider: () => provider });
  expect(await svc.refresh(a.id)).toBe('failed'); expect(await svc.refresh(b.id)).toBe('ok');
  const [sa, sb] = svc.getStates();
  expect(sa).toMatchObject({ phase: 'error', lastError: 'boom' });
  expect(sb).toMatchObject({ phase: 'ok', snapshot: { address: { house: '2' } } });
  expect(sb.lastError).toBeUndefined();
  expect(store.getSnapshot(b.id)?.address.house).toBe('2'); expect(store.getSnapshot(a.id)).toBeNull();
});

test('a result for a deleted location is dropped', async () => {
  const { store, svc, pending, flush } = controlled();
  const a = place(store, 'А', addrFor('1')); place(store, 'Б', addrFor('2'));
  const run = svc.refresh(a.id); await flush();
  store.removeLocation(a.id); svc.forget(a.id);
  pending[0].resolve();
  expect(await run).toBe('ok');
  expect(store.getSnapshot(a.id)).toBeNull();
  expect(svc.getStates().map(s => s.location.id)).not.toContain(a.id);
});

test('addressChanged drops the snapshot and the error', async () => {
  const store = newStore();
  const loc = place(store, 'А', addrFor('1'));
  let seen: unknown;
  const fetchSnapshot = vi.fn(async (): Promise<ScheduleSnapshot> => { throw new ProviderError('boom'); });
  const provider = { fetchSnapshot } as unknown as ScheduleProvider;
  const svc = new RefreshService({ store, getProvider: () => provider });
  store.setSnapshot(loc.id, snapFor(addrFor('1')));
  await svc.refresh(loc.id);
  expect(svc.getStates()[0]).toMatchObject({ phase: 'error', lastError: 'boom' });
  rehouse(store, loc.id, '2');
  store.setSnapshot(loc.id, snapFor(addrFor('2')));
  fetchSnapshot.mockImplementationOnce(async () => { seen = { snap: store.getSnapshot(loc.id), err: svc.getStates()[0].lastError }; return snapFor(addrFor('2')); });
  await svc.addressChanged(loc.id);
  expect(seen).toEqual({ snap: null, err: undefined });
});

test('a store failure while saving is an error state, not a rejection or a wedge', async () => {
  const { svc, store, id, state } = setup(async () => fixtureSnapshot());
  vi.spyOn(store, 'setSnapshot').mockImplementationOnce(() => { throw new Error('EBUSY'); });
  expect(await svc.refresh(id)).toBe('failed');
  expect(state()).toMatchObject({ phase: 'error', lastError: 'EBUSY' });
  expect(await svc.refresh(id)).toBe('ok');
});

test('a queue missing from lines is not a line change while the source reports an outage', () => {
  const during = { ...fixtureSnapshot(), outageActive: true, lines: [{ index: 1, groupId: 'GPV4.2', label: 'Черга 4.2' }] };
  expect(setup(async () => during, { cached: during }).state().lineChanged).toBe(false);
  const after = { ...during, outageActive: false };
  expect(setup(async () => after, { cached: after }).state().lineChanged).toBe(true);
  const moved = { ...fixtureSnapshot(), lines: [{ index: 1, groupId: 'GPV4.2', label: 'Черга 4.2' }, { index: 2, groupId: 'GPV1.2', label: 'Черга 1.2' }] };
  expect(setup(async () => moved, { cached: moved }).state().lineChanged).toBe(false); // still listed, other position
});
