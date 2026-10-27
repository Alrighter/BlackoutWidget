import { composeAppState, widgetStateOf } from '../../src/main/compose-state';
import type { ActualStatus, Location, LocationState, Settings } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const loc = (id: string, name: string): Location =>
  ({ id, name, address: fixtureSnapshot().address, widgetStyle: 'ring', widgetPosition: null });
const ls = (id: string, name: string, withSnapshot = true): LocationState =>
  ({ location: loc(id, name), snapshot: withSnapshot ? fixtureSnapshot() : null, phase: 'ok', lineChanged: false });
const settings = (actualLocationId: string | null, ...ids: string[]): Settings =>
  ({ locations: ids.map(i => loc(i, i)), actualLocationId, autostart: true, actualSource: null });
const ACTUAL: ActualStatus = { sourceLabel: 'EcoFlow', power: 'on', history: [] };

test('actual goes only to the EcoFlow location; AppState.actual is the station status', () => {
  const s = composeAppState(settings('b', 'a', 'b'), [ls('a', 'a'), ls('b', 'b')], ACTUAL, true);
  expect(s.locations[0].actual).toBeUndefined();
  expect(s.locations[1].actual).toBe(ACTUAL);
  expect(s.actual).toBe(ACTUAL);
});

test('with no EcoFlow location no location carries actual', () => {
  const s = composeAppState(settings(null, 'a', 'b'), [ls('a', 'a'), ls('b', 'b')], ACTUAL, true);
  expect(s.locations.every(l => l.actual === undefined)).toBe(true);
  expect(s.actual).toBe(ACTUAL);
});

test('settingsLoaded is passed through, the locations keep their order', () => {
  expect(composeAppState(settings(null, 'a'), [ls('a', 'a')], undefined, false).settingsLoaded).toBe(false);
  expect(composeAppState(settings(null, 'a'), [ls('a', 'a')], undefined, true).settingsLoaded).toBe(true);
  expect(composeAppState(settings(null, 'a', 'b'), [ls('a', 'a'), ls('b', 'b')], null, true).locations.map(l => l.location.id)).toEqual(['a', 'b']);
});

test('widgetStateOf: showName only with several locations; null for an unknown id', () => {
  const one = composeAppState(settings(null, 'a'), [ls('a', 'a')], undefined, true);
  expect(widgetStateOf(one, 'a')?.showName).toBe(false);
  const two = composeAppState(settings('a', 'a', 'b'), [ls('a', 'a'), ls('b', 'b', false)], ACTUAL, true);
  expect(widgetStateOf(two, 'b')?.showName).toBe(true);
  expect(widgetStateOf(two, 'zzz')).toBeNull();
});

test("widgetStateOf never includes another location's snapshot or actual", () => {
  const two = composeAppState(settings('a', 'a', 'b'), [ls('a', 'a'), ls('b', 'b', false)], ACTUAL, true);
  const w = widgetStateOf(two, 'b')!;
  expect(w.location.location.id).toBe('b');
  expect(w.location.snapshot).toBeNull();
  expect(w.location.actual).toBeUndefined();
  expect(Object.keys(w).sort()).toEqual(['location', 'showName']);
});

test('update is passed through, and absent when not given', () => {
  const update = { phase: 'available', version: '1.0.2' } as const;
  expect(composeAppState(settings(null, 'a'), [ls('a', 'a')], undefined, true, update).update).toEqual(update);
  expect('update' in composeAppState(settings(null, 'a'), [ls('a', 'a')], undefined, true)).toBe(false);
});
