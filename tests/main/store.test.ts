import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, DEFAULT_SETTINGS } from '../../src/main/store';

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
