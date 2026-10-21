import { migrateSettings } from '../../src/main/settings-migration';
import type { ActualSourceConfig } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const CONFIG: ActualSourceConfig = { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'Delta', accessKeyHint: 'AKEY…' };
const address = fixtureSnapshot().address;

test('an old address becomes location home', () => {
  const { settings, migrated } = migrateSettings({
    address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 }, autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1',
  });
  expect(settings.locations).toEqual([{ id: 'home', name: 'Дім', address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 } }]);
  expect(settings).toMatchObject({ actualLocationId: 'home', autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1' });
  expect('address' in settings).toBe(false);
  expect('widgetStyle' in settings).toBe(false);
  expect('widgetPosition' in settings).toBe(false);
  expect(migrated).toBe(true);
});

test('no style → compact', () => {
  const { settings } = migrateSettings({ address });
  expect(settings.locations[0]).toMatchObject({ widgetStyle: 'compact', widgetPosition: null });
});

test('address null → no locations', () => {
  const { settings, migrated } = migrateSettings({ address: null, widgetStyle: 'ring' });
  expect(settings).toMatchObject({ locations: [], actualLocationId: null });
  expect(migrated).toBe(true);
});

test('the new shape is left alone', () => {
  const locations = [{ id: 'a', name: 'Дім', address, widgetStyle: 'ring', widgetPosition: null }];
  const { settings, migrated } = migrateSettings({ locations, actualLocationId: 'a' });
  expect(settings.locations).toEqual(locations);
  expect(migrated).toBe(false);
});

test('a file with nothing old in it is not rewritten', () => {
  expect(migrateSettings({})).toMatchObject({ settings: { locations: [] }, migrated: false });
});
