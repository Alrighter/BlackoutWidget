import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, DEFAULT_SETTINGS, LocationError, READ_RETRIES } from '../../src/main/store';
import type { ActualSourceConfig, Location } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const tmp = () => mkdtempSync(join(tmpdir(), 'bw-'));
const address = fixtureSnapshot().address;
const input = (name: string) => ({ name, address, widgetStyle: 'compact' as const, widgetPosition: null });
const counter = () => { let n = 0; return () => `id${++n}`; };
const readJson = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

test('missing file → defaults; round trip; corrupt → defaults; no tmp left', () => {
  const dir = tmp();
  const s = new AppStore(dir);
  expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
  expect(s.settingsLoaded).toBe(true); // a missing file is a successful read
  s.updateSettings({ autostart: false });
  expect(new AppStore(dir).getSettings().autostart).toBe(false);
  writeFileSync(join(dir, 'settings.json'), '{oops');
  expect(new AppStore(dir).getSettings()).toEqual(DEFAULT_SETTINGS);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
/** Real reads, except that `failures` reads of settings.json throw EBUSY. */
function lockable(dir: string) {
  const ctl = { failures: 0, calls: 0 };
  const store = new AppStore(dir, {
    readFile: p => {
      if (p.endsWith('settings.json')) { ctl.calls++; if (ctl.failures > 0) { ctl.failures--; throw busy(); } }
      return readFileSync(p, 'utf8');
    },
  });
  return { store, ctl };
}

test('a locked settings file never gets overwritten with defaults', () => {
  const dir = tmp();
  new AppStore(dir).addLocation(input('Дім'));
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const { store, ctl } = lockable(dir);
  ctl.failures = Infinity;
  expect(() => store.updateSettings({ autostart: false })).toThrow(/EBUSY/);
  expect(ctl.calls).toBe(READ_RETRIES + 1); // retried briefly, then gave up
  expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  expect(store.getSettings()).toEqual(DEFAULT_SETTINGS); // display fallback only, nothing read yet
});

test('a briefly locked settings file is retried; later failures fall back to the last good settings for display', () => {
  const dir = tmp();
  const loc = new AppStore(dir).addLocation(input('Дім'));
  const { store, ctl } = lockable(dir);
  ctl.failures = 2;
  expect(store.updateSettings({ autostart: false })).toMatchObject({ autostart: false, locations: [loc] });
  ctl.failures = Infinity;
  expect(store.getSettings()).toMatchObject({ autostart: false, locations: [loc] });
  expect(store.settingsLoaded).toBe(true); // stays true after one success
});

test('unreadable at start: defaults for display, not loaded', () => {
  const dir = tmp();
  new AppStore(dir).addLocation(input('Дім'));
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const { store, ctl } = lockable(dir);
  ctl.failures = Infinity;
  expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
  expect(store.settingsLoaded).toBe(false);
  expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  ctl.failures = 0;
  expect(store.getSettings().locations).toHaveLength(1);
  expect(store.settingsLoaded).toBe(true);
});

test('snapshot read failure keeps the last snapshot instead of throwing', () => {
  const dir = tmp();
  let locked = false;
  const store = new AppStore(dir, { readFile: p => { if (locked && p.endsWith('snapshots.json')) throw busy(); return readFileSync(p, 'utf8'); } });
  store.setSnapshot('home', fixtureSnapshot());
  expect(store.getSnapshot('home')?.groupId).toBe('GPV1.2');
  locked = true;
  expect(store.getSnapshot('home')?.groupId).toBe('GPV1.2');
});

test('snapshots are kept per location; null deletes the entry', () => {
  const dir = tmp();
  const store = new AppStore(dir);
  store.setSnapshot('a', fixtureSnapshot());
  store.setSnapshot('b', fixtureSnapshot({ groupId: 'GPV2.1' }));
  expect(store.getSnapshot('a')?.groupId).toBe('GPV1.2');
  expect(store.getSnapshot('b')?.groupId).toBe('GPV2.1');
  store.setSnapshot('a', null);
  expect(store.getSnapshot('a')).toBeNull();
  expect(Object.keys(readJson(dir, 'snapshots.json'))).toEqual(['b']);
});

test('an old settings.json without actualSource reads as null', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ address, widgetStyle: 'ring' }));
  const s = new AppStore(dir).getSettings();
  expect(s.locations[0].widgetStyle).toBe('ring');
  expect(s.actualSource).toBeNull();
  expect(DEFAULT_SETTINGS.actualSource).toBeNull();
});

test('an ecoflow-app source and its uuid round-trip; an old ecoflow source loads unchanged', () => {
  const dir = tmp();
  const app = { id: 'ecoflow-app' as const, region: 'eu' as const, deviceSn: 'SN1', deviceName: 'RIVER 2', accountHint: 'r…@dully.io' };
  new AppStore(dir).updateSettings({ actualSource: app, ecoflowAppClientUuid: 'A'.repeat(32) });
  const loaded = new AppStore(dir).getSettings();
  expect(loaded.actualSource).toEqual(app);
  expect(loaded.ecoflowAppClientUuid).toBe('A'.repeat(32));

  const old = { id: 'ecoflow', region: 'us', deviceSn: 'SN2', deviceName: 'Delta', accessKeyHint: 'AKEY…' };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ actualSource: old, ecoflowClientId: 'BlackoutWidget-abc12345' }));
  const legacy = new AppStore(dir).getSettings();
  expect(legacy.actualSource).toEqual(old);
  expect(legacy.ecoflowClientId).toBe('BlackoutWidget-abc12345');
});

const CONFIG: ActualSourceConfig = { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'Delta', accessKeyHint: 'AKEY…' };
const legacyFile = {
  address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 }, autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1',
};

test('a real old settings file migrates whole', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacyFile));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(fixtureSnapshot()));
  const s = new AppStore(dir);
  expect(s.getSettings()).toMatchObject({
    locations: [{ id: 'home', name: 'Дім', address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 } }],
    actualLocationId: 'home', autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1',
  });
  // The whole file: the one location, every other key carried as it was, and no old key left.
  expect(readJson(dir, 'settings.json')).toEqual({
    locations: [{ id: 'home', name: 'Дім', address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 } }],
    actualLocationId: 'home', autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1',
  });
  expect(s.getSnapshot('home')).toEqual(fixtureSnapshot());
  expect(existsSync(join(dir, 'snapshot.json'))).toBe(false);
});

test('a legacy snapshot for another address is not carried', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacyFile));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(fixtureSnapshot({ lineIndex: 2 })));
  expect(new AppStore(dir).getSnapshot('home')).toBeNull();
});

test('a legacy snapshot.json without an address is not carried, and the migration still lands on disk', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacyFile));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ groupId: 'GPV1.2' })); // valid JSON, not a snapshot
  const s = new AppStore(dir);
  expect(s.getSettings().locations.map(l => l.id)).toEqual(['home']);
  const onDisk = readJson(dir, 'settings.json');
  expect(onDisk.locations.map((l: Location) => l.id)).toEqual(['home']);
  for (const k of ['address', 'widgetStyle', 'widgetPosition']) expect(k in onDisk).toBe(false);
  expect(existsSync(join(dir, 'snapshot.json'))).toBe(false);
  expect(s.getSnapshot('home')).toBeNull();
});

test('a migration that cannot be written keeps the same id', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacyFile));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(fixtureSnapshot()));
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const s = new AppStore(dir, { writeFile: () => { throw new Error('EPERM'); }, newId: () => 'other' });
  expect(s.getSettings().locations[0].id).toBe('home');
  expect(s.getSettings().locations[0].id).toBe('home');
  expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  expect(existsSync(join(dir, 'snapshot.json'))).toBe(true); // kept until the migration is on disk
});

test('addLocation', () => {
  const s = new AppStore(tmp(), { newId: counter() });
  const first = s.addLocation(input('Дім'));
  expect(first.id).toBe('id1');
  expect(s.getSettings().actualLocationId).toBe('id1');
  expect(s.addLocation(input('  Батьки '))).toMatchObject({ id: 'id2', name: 'Батьки' });
  expect(s.getSettings().actualLocationId).toBe('id1');
  expect(() => s.addLocation(input('дім'))).toThrow(new LocationError('Така назва вже є'));
  expect(() => s.addLocation(input('   '))).toThrow('Вкажіть назву');
  for (const n of ['A', 'B', 'C']) s.addLocation(input(n));
  expect(() => s.addLocation(input('Шоста'))).toThrow('Можна додати до 5 адрес');
  expect(s.getSettings().locations.map(l => l.id)).toEqual(['id1', 'id2', 'id3', 'id4', 'id5']);
});

test("updateLocation reads fresh: another writer's change survives", () => {
  const dir = tmp();
  const A = new AppStore(dir, { newId: () => 'home' });
  const B = new AppStore(dir);
  A.addLocation(input('Дім'));
  const P = { x: 5, y: 6, displayId: 2 };
  A.updateLocation('home', l => ({ ...l, widgetPosition: P }));
  B.updateLocation('home', l => ({ ...l, name: 'Хата' }));
  const [loc] = readJson(dir, 'settings.json').locations as Location[];
  expect(loc).toMatchObject({ name: 'Хата', widgetPosition: P });
  expect(() => A.updateLocation('nope', l => l)).toThrow('Цієї адреси вже немає');
  expect(A.updateLocation('home', l => ({ ...l, id: 'hijack' })).id).toBe('home');
  expect(readJson(dir, 'settings.json').locations.map((l: Location) => l.id)).toEqual(['home']);
});

test('updateLocation checks the name against the other locations only', () => {
  const s = new AppStore(tmp(), { newId: counter() });
  s.addLocation(input('Дім'));
  s.addLocation(input('Батьки'));
  expect(s.updateLocation('id1', l => ({ ...l, name: ' ДІМ ' })).name).toBe('ДІМ');
  expect(() => s.updateLocation('id1', l => ({ ...l, name: 'батьки' }))).toThrow('Така назва вже є');
  expect(s.getLocation('id1')?.name).toBe('ДІМ');
  expect(s.getLocation('zzz')).toBeNull();
});

test('removeLocation', () => {
  const dir = tmp();
  const s = new AppStore(dir, { newId: counter() });
  s.addLocation(input('Дім'));
  expect(() => s.removeLocation('id1')).toThrow('Останню адресу видалити не можна');
  s.addLocation(input('Батьки'));
  s.setSnapshot('id1', fixtureSnapshot());
  s.setSnapshot('id2', fixtureSnapshot());
  s.removeLocation('id2');
  expect(s.getSettings().locations.map(l => l.id)).toEqual(['id1']);
  expect(s.getSettings().actualLocationId).toBe('id1');
  expect(Object.keys(readJson(dir, 'snapshots.json'))).toEqual(['id1']);
  s.addLocation(input('Інша'));
  s.removeLocation('id1');
  expect(s.getSettings().actualLocationId).toBeNull();
  expect(() => s.removeLocation('id1')).toThrow('Цієї адреси вже немає');
});
