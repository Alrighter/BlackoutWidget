import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, DEFAULT_SETTINGS, READ_RETRIES } from '../../src/main/store';
import { fixtureSnapshot } from '../helpers/snapshot';

test('missing file → defaults; round trip; corrupt → defaults; no tmp left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  const s = new AppStore(dir);
  expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
  s.updateSettings({ widgetStyle: 'ring' });
  expect(new AppStore(dir).getSettings().widgetStyle).toBe('ring');
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
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  const address = fixtureSnapshot().address;
  new AppStore(dir).updateSettings({ address, widgetStyle: 'timeline' });
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const { store, ctl } = lockable(dir);
  ctl.failures = Infinity;
  expect(() => store.updateSettings({ autostart: false })).toThrow(/EBUSY/);
  expect(ctl.calls).toBe(READ_RETRIES + 1); // retried briefly, then gave up
  expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  expect(store.getSettings()).toEqual(DEFAULT_SETTINGS); // display fallback only, nothing read yet
});

test('a briefly locked settings file is retried; later failures fall back to the last good settings for display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  const address = fixtureSnapshot().address;
  new AppStore(dir).updateSettings({ address });
  const { store, ctl } = lockable(dir);
  ctl.failures = 2;
  expect(store.updateSettings({ widgetStyle: 'ring' })).toMatchObject({ address, widgetStyle: 'ring' });
  ctl.failures = Infinity;
  expect(store.getSettings()).toMatchObject({ address, widgetStyle: 'ring' });
});

test('snapshot read failure keeps the last snapshot instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  let locked = false;
  const store = new AppStore(dir, { readFile: p => { if (locked && p.endsWith('snapshot.json')) throw busy(); return readFileSync(p, 'utf8'); } });
  store.setSnapshot(fixtureSnapshot());
  locked = true;
  expect(store.getSnapshot()?.groupId).toBe('GPV1.2');
});

test('old settings.json without actualSource reads as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  writeFileSync(join(dir, 'settings.json'), '{"widgetStyle":"ring"}');
  const s = new AppStore(dir).getSettings();
  expect(s.widgetStyle).toBe('ring');
  expect(s.actualSource).toBeNull();
  expect(DEFAULT_SETTINGS.actualSource).toBeNull();
});
