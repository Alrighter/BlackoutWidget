import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, LocationError } from '../../src/main/store';
import { createLocationActions } from '../../src/main/location-actions';
import { NAME_TAKEN, UNKNOWN_LOCATION, normalizeName } from '../../src/shared/locations';
import { fixtureSnapshot } from '../helpers/snapshot';

const addr = fixtureSnapshot().address;
const POS = { x: 5, y: 6, displayId: 1 };
function setup() {
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  const calls: string[] = [];
  const service = { addressChanged: vi.fn(async (id: string) => { calls.push(`addressChanged:${id}`); }), forget: vi.fn((id: string) => { calls.push(`forget:${id}`); }) };
  const placeNew = vi.fn(() => POS);
  const changed = vi.fn(() => { calls.push('changed'); });
  const actions = createLocationActions({ store, service, isProvider: id => id === addr.providerId, placeNew, changed });
  return { store, service, placeNew, changed, actions, calls };
}
const input = (over: Record<string, unknown> = {}) => ({ name: '  Дача   мама ', address: addr, widgetStyle: 'ring', ...over });

describe('add', () => {
  test('validates the style, the provider and the name rules', () => {
    const { actions, changed } = setup();
    expect(() => actions.add(input({ widgetStyle: 'huge' }))).toThrow(LocationError);
    expect(() => actions.add(input({ address: { ...addr, providerId: 'nope' } }))).toThrow(LocationError);
    expect(() => actions.add(input({ address: { city: 1 } }))).toThrow(LocationError);
    expect(() => actions.add(null)).toThrow(LocationError);
    expect(() => actions.add(input({ name: '   ' }))).toThrow(LocationError);
    actions.add(input());
    expect(() => actions.add(input({ name: 'ДАЧА МАМА' }))).toThrow(NAME_TAKEN);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test('stores the normalized name and the placement, then calls changed once', () => {
    const { actions, store, placeNew, changed } = setup();
    const loc = actions.add(input());
    expect(loc.name).toBe(normalizeName('  Дача   мама '));
    expect(placeNew).toHaveBeenCalledWith('ring');
    expect(store.getLocation(loc.id)).toMatchObject({ name: loc.name, widgetPosition: POS, widgetStyle: 'ring' });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('edit', () => {
  test('the same address never calls addressChanged', async () => {
    const { actions, service } = setup();
    const loc = actions.add(input());
    await actions.edit(loc.id, input({ name: 'Інша' }));
    expect(service.addressChanged).not.toHaveBeenCalled();
  });
  test('a new house calls addressChanged once, after the store write', async () => {
    const { actions, service, store } = setup();
    const loc = actions.add(input());
    service.addressChanged.mockImplementationOnce(async id => { expect(store.getLocation(id)!.address.house).toBe('99'); });
    await actions.edit(loc.id, input({ address: { ...addr, house: '99' } }));
    expect(service.addressChanged).toHaveBeenCalledTimes(1);
    expect(service.addressChanged).toHaveBeenCalledWith(loc.id);
  });
  test('an unknown or non-string id throws', async () => {
    const { actions } = setup();
    await expect(actions.edit('x', input())).rejects.toThrow(UNKNOWN_LOCATION);
    await expect(actions.edit(5, input())).rejects.toThrow(UNKNOWN_LOCATION);
  });
});

test('rename and setStyle write the store and call changed', () => {
  const { actions, store, changed } = setup();
  const loc = actions.add(input());
  changed.mockClear();
  actions.rename(loc.id, ' Нова  назва ');
  actions.setStyle(loc.id, 'timeline');
  expect(store.getLocation(loc.id)).toMatchObject({ name: 'Нова назва', widgetStyle: 'timeline' });
  expect(changed).toHaveBeenCalledTimes(2);
  expect(() => actions.setStyle(loc.id, 'huge')).toThrow(LocationError);
  expect(() => actions.rename(loc.id, 7)).toThrow(LocationError);
});

test('remove calls the store, then forget, then changed', () => {
  const { actions, store, calls } = setup();
  actions.add(input());
  const b = actions.add(input({ name: 'Друга' }));
  calls.length = 0;
  actions.remove(b.id);
  expect(store.getLocation(b.id)).toBeNull();
  expect(calls).toEqual([`forget:${b.id}`, 'changed']);
});

test('remove of an unknown id throws and forgets nothing', () => {
  const { actions, service } = setup();
  actions.add(input());
  expect(() => actions.remove('nope')).toThrow(UNKNOWN_LOCATION);
  expect(service.forget).not.toHaveBeenCalled();
});

describe('setActualLocation', () => {
  test('sets the id and calls changed', () => {
    const { actions, store, changed } = setup();
    actions.add(input());
    const b = actions.add(input({ name: 'Друга' }));
    changed.mockClear();
    actions.setActualLocation(b.id);
    expect(store.getSettings().actualLocationId).toBe(b.id);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test('throws for an unknown id', () => {
    const { actions } = setup();
    expect(() => actions.setActualLocation('nope')).toThrow(UNKNOWN_LOCATION);
  });
});

test('any non-string id throws the unknown-location text', () => {
  const { actions } = setup();
  for (const bad of [undefined, null, 5, {}, ['a']]) {
    expect(() => actions.rename(bad, 'x')).toThrow(UNKNOWN_LOCATION);
    expect(() => actions.remove(bad)).toThrow(UNKNOWN_LOCATION);
    expect(() => actions.setStyle(bad, 'ring')).toThrow(UNKNOWN_LOCATION);
    expect(() => actions.setActualLocation(bad)).toThrow(UNKNOWN_LOCATION);
  }
});
