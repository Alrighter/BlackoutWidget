import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocationRuntime, opensSetupAtBoot } from '../../src/main/location-runtime';
import { STAGGER_MS, startDelays } from '../../src/main/scheduler';
import { AppStore } from '../../src/main/store';
import { fixtureSnapshot } from '../helpers/snapshot';

const address = fixtureSnapshot().address; // every location on one provider: the boot staggers them
const input = (name: string) => ({ name, address, widgetStyle: 'compact' as const, widgetPosition: null });
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

interface Opts { failScheduler?: Set<string>; failWidget?: Set<string>; failRefit?: Set<string> }

/**
 * A real store in a temp dir whose settings.json can be locked, and a runtime whose factories record what they do.
 * `publish` reads the state as main's getState does: the settings first, then whether they are real ones.
 */
function setup(names: string[], opts: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const ctl = { locked: false, quitting: false };
  const readFile = (p: string) => {
    if (ctl.locked && p.endsWith('settings.json')) throw busy();
    return readFileSync(p, 'utf8');
  };
  const store = new AppStore(dir, { readFile, newId: () => ids.shift()! });
  for (const n of names) store.addLocation(input(n));
  const events: string[] = [];
  const delays: [string, number][] = [];
  const log = { error: vi.fn() };
  const runtime = new LocationRuntime({
    log,
    createScheduler: (id, delayMs) => {
      if (opts.failScheduler?.has(id)) throw new Error('no timer');
      events.push(`+s:${id}`);
      delays.push([id, delayMs]);
      return { id, trigger: vi.fn() };
    },
    disposeScheduler: (_s, id) => { events.push(`-s:${id}`); },
    createWidget: id => {
      if (opts.failWidget?.has(id)) throw new Error('no window');
      events.push(`+w:${id}`);
      return {
        window: {
          refit: () => { if (opts.failRefit?.has(id)) throw new Error('no display'); events.push(`refit:${id}`); },
          sync: () => { events.push(`sync:${id}`); },
          show: () => { events.push(`show:${id}`); },
        },
      };
    },
    disposeWidget: (_w, id) => { events.push(`-w:${id}`); },
    startDelays,
    quitting: () => ctl.quitting,
  });
  const publish = () => {
    const settings = store.getSettings();
    runtime.reconcile({ settings, settingsLoaded: store.settingsLoaded });
  };
  /** A fresh store on the same folder, as at the next app start: nothing read yet. */
  const restart = () => new AppStore(dir, { readFile });
  return { store, runtime, events, delays, log, ctl, publish, restart };
}

const only = (events: string[], prefix: string) => events.filter(e => e.startsWith(prefix));

test('settings not read yet: nothing is built; once the file reads, the widgets and the schedulers appear', () => {
  const t = setup(['Дім', 'Батьки']);
  const store = t.restart();
  const runtime = t.runtime;
  t.ctl.locked = true;
  const publish = () => { const settings = store.getSettings(); runtime.reconcile({ settings, settingsLoaded: store.settingsLoaded }); };
  publish();
  expect(store.settingsLoaded).toBe(false);
  expect(t.events).toEqual([]);
  expect(runtime.widgets()).toEqual([]);
  expect(runtime.schedulers()).toEqual([]);

  t.ctl.locked = false;
  publish();
  expect(t.events).toEqual([
    '+s:a', '+s:b', '+w:a', '+w:b', 'refit:a', 'refit:b', 'sync:a', 'show:a', 'sync:b', 'show:b',
  ]);
  // The boot stagger comes from the real settings, not from the fallback's empty list.
  expect(t.delays).toEqual([['a', 0], ['b', STAGGER_MS]]);
  expect(runtime.widgets()).toHaveLength(2);
  expect(runtime.schedulers().map(s => s.id)).toEqual(['a', 'b']);
  expect(runtime.scheduler('b')?.id).toBe('b');
  expect(runtime.widget('a')).toBe(runtime.widgets()[0]);
});

test('the boot stagger is used once: a location added later starts at once', () => {
  const t = setup(['Дім', 'Батьки']);
  t.publish();
  expect(t.delays).toEqual([['a', 0], ['b', STAGGER_MS]]);
  t.publish();
  expect(t.delays).toHaveLength(2); // kept, not built again
  t.store.addLocation(input('Дача'));
  t.publish();
  expect(t.delays).toEqual([['a', 0], ['b', STAGGER_MS], ['c', 0]]);
});

test('a deleted location is disposed and never comes back, also while the file cannot be read', () => {
  const t = setup(['Дім', 'Батьки']);
  t.publish();
  t.events.length = 0;
  t.store.removeLocation('b');
  t.publish();
  expect(t.events).toEqual(['-s:b', '-w:b', 'sync:a', 'show:a']);
  expect(t.runtime.widget('b')).toBeUndefined();
  expect(t.runtime.scheduler('b')).toBeUndefined();

  t.events.length = 0;
  t.ctl.locked = true; // the display fallback: the last settings written, without b
  t.publish();
  t.ctl.locked = false;
  t.publish();
  expect(only(t.events, '+')).toEqual([]);
  expect(only(t.events, '-')).toEqual([]);
  expect(t.runtime.schedulers().map(s => s.id)).toEqual(['a']);
});

test('a later unreadable read keeps every widget: the fallback is never taken for an empty list', () => {
  const t = setup(['Дім', 'Батьки']);
  t.publish();
  t.events.length = 0;
  t.ctl.locked = true;
  t.publish();
  expect(only(t.events, '-')).toEqual([]);
  expect(t.runtime.widgets()).toHaveLength(2);
});

test('quitting: nothing is built, not even a location that reads now', () => {
  const t = setup(['Дім']);
  t.ctl.quitting = true;
  t.publish();
  expect(t.events).toEqual([]);

  const u = setup(['Дім']);
  u.publish();
  u.events.length = 0;
  u.ctl.quitting = true;
  u.store.addLocation(input('Батьки'));
  u.publish();
  expect(u.events).toEqual([]);
  expect(u.runtime.widget('b')).toBeUndefined();
});

test('only the widgets this reconcile built are refit, in location order, before any is shown', () => {
  const t = setup(['Дім', 'Батьки']);
  t.publish();
  expect(only(t.events, 'refit:')).toEqual(['refit:a', 'refit:b']);
  t.events.length = 0;
  t.store.addLocation(input('Дача'));
  t.store.addLocation(input('Офіс'));
  t.publish();
  expect(only(t.events, 'refit:')).toEqual(['refit:c', 'refit:d']);
  expect(t.events.indexOf('refit:d')).toBeLessThan(t.events.indexOf('show:a'));
  t.events.length = 0;
  t.publish();
  expect(only(t.events, 'refit:')).toEqual([]);
  expect(only(t.events, 'show:')).toEqual(['show:a', 'show:b', 'show:c', 'show:d']);
});

test('a widget whose creation threw is built on the next reconcile and refit then as a new one', () => {
  const failWidget = new Set(['a']);
  const t = setup(['Дім', 'Батьки'], { failWidget });
  t.publish();
  expect(only(t.events, '+w:')).toEqual(['+w:b']);
  expect(only(t.events, 'refit:')).toEqual(['refit:b']);
  expect(t.log.error).toHaveBeenCalledTimes(1);
  expect(t.log.error).toHaveBeenCalledWith('widget: could not be built for location a', expect.any(Error));

  t.events.length = 0;
  t.publish(); // still failing: one more line for this reconcile
  expect(t.log.error).toHaveBeenCalledTimes(2);
  failWidget.clear();
  t.events.length = 0;
  t.publish();
  expect(only(t.events, '+w:')).toEqual(['+w:a']);
  expect(only(t.events, 'refit:')).toEqual(['refit:a']);
  expect(t.runtime.widgets()).toHaveLength(2);
  expect(t.log.error).toHaveBeenCalledTimes(2);
});

test('a scheduler whose creation threw is built on the next reconcile, starting at once', () => {
  const failScheduler = new Set(['b']);
  const t = setup(['Дім', 'Батьки'], { failScheduler });
  t.publish();
  expect(t.delays).toEqual([['a', 0]]);
  expect(t.runtime.scheduler('b')).toBeUndefined();
  expect(t.runtime.schedulers().map(s => s.id)).toEqual(['a']);
  failScheduler.clear();
  t.publish();
  expect(t.delays).toEqual([['a', 0], ['b', 0]]);
});

test('a refit that throws is logged by id, and every widget is still shown', () => {
  const t = setup(['Дім', 'Батьки'], { failRefit: new Set(['a']) });
  t.publish();
  expect(t.log.error).toHaveBeenCalledWith('widget: refit failed for location a', expect.any(Error));
  expect(only(t.events, 'show:')).toEqual(['show:a', 'show:b']);
});

test('clear disposes the widgets, then the schedulers', () => {
  const t = setup(['Дім', 'Батьки']);
  t.publish();
  t.events.length = 0;
  t.runtime.clear();
  expect(t.events).toEqual(['-w:a', '-w:b', '-s:a', '-s:b']);
  expect(t.runtime.widgets()).toEqual([]);
});

describe('opensSetupAtBoot', () => {
  test('a settings file that cannot be read at start is not a new install', () => {
    const t = setup(['Дім']);
    t.ctl.locked = true;
    expect(opensSetupAtBoot(t.restart())).toBe(false);
    const empty = setup([]);
    empty.ctl.locked = true;
    expect(opensSetupAtBoot(empty.restart())).toBe(false);
  });

  test('a file read with no locations opens the wizard; one with a location does not', () => {
    expect(opensSetupAtBoot(setup([]).restart())).toBe(true);
    expect(opensSetupAtBoot(setup(['Дім']).restart())).toBe(false);
  });
});
