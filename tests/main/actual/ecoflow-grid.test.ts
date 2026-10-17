import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGrid } from '../../../src/main/actual/ecoflow/grid';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, '../../fixtures/ecoflow', n), 'utf8'));

test('River 2: mV voltage → on', () => expect(detectGrid(fx('river2-grid-on.json'))).toEqual({ power: 'on', detail: 'на вході 229 В' }));
test('Delta 2: voltage present with 0 W is still on', () => expect(detectGrid(fx('delta2-grid-on-0w.json'))).toEqual({ power: 'on', detail: 'на вході 229 В' }));
test('Delta Pro without grid → off', () => expect(detectGrid(fx('deltapro-grid-off.json'))).toEqual({ power: 'off', detail: 'на вході 0 В' }));
test('Delta 3 family: volts, not mV', () => expect(detectGrid(fx('delta3-grid-on.json'))).toEqual({ power: 'on', detail: 'на вході 230 В' }));
test('unknown model', () => expect(detectGrid(fx('unsupported.json'))).toEqual({ power: 'unknown', reason: 'модель поки не підтримується', unsupported: true }));
test('49 999 mV is off, 50 000 mV is on', () => {
  expect(detectGrid({ 'inv.acInVol': 49999 }).power).toBe('off');
  expect(detectGrid({ 'inv.acInVol': 50000 }).power).toBe('on');
});
test('insane voltage falls through to frequency', () => {
  expect(detectGrid({ plugInInfoAcInVol: 228652, plugInInfoAcInFeq: 50 })).toEqual({ power: 'on', detail: 'на вході 50 Гц' });
});
test('frequency 0 → off; flag true → on; watts only', () => {
  expect(detectGrid({ 'inv.acInFreq': 0 }).power).toBe('off');
  expect(detectGrid({ plugInInfoAcInFlag: true })).toEqual({ power: 'on', detail: 'вхід AC підключено' });
  expect(detectGrid({ plugInInfoAcInFlag: 0 })).toEqual({ power: 'off', detail: 'вхід AC не підключено' });
  expect(detectGrid({ powGetAcIn: 120.4 })).toEqual({ power: 'on', detail: 'на вході 120 Вт' });
  expect(detectGrid({ 'inv.inputWatts': 0 })).toEqual({ power: 'unknown', reason: 'не вдається визначити', unsupported: false });
});
test('non-numeric values are ignored, never read as 0', () => {
  expect(detectGrid({ 'inv.acInVol': null, 'inv.acInFreq': '50' }).power).toBe('unknown');
});
test('frequency between 0 and 40 Hz is skipped, not read as off', () => {
  for (const hz of [1, 39]) {
    expect(detectGrid({ 'inv.acInFreq': hz })).toEqual({ power: 'unknown', reason: 'модель поки не підтримується', unsupported: true });
    expect(detectGrid({ 'inv.acInFreq': hz, plugInInfoAcInFlag: 1 })).toEqual({ power: 'on', detail: 'вхід AC підключено' });
    expect(detectGrid({ 'inv.acInFreq': hz, 'inv.inputWatts': 80 })).toEqual({ power: 'on', detail: 'на вході 80 Вт' });
  }
  expect(detectGrid({ 'inv.acInFreq': 40 }).power).toBe('on');
});
test('voltage off with a grid frequency is a conflict → unknown (ruling R13)', () => {
  const conflict = { power: 'unknown', reason: 'покази суперечать одне одному', unsupported: false };
  // A firmware reporting inv.acInVol in volts would read 0.23 V.
  expect(detectGrid({ 'inv.acInVol': 230, 'inv.acInFreq': 50 })).toEqual(conflict);
  expect(detectGrid({ plugInInfoAcInVol: 0, plugInInfoAcInFeq: 40 })).toEqual(conflict);
  expect(detectGrid({ 'inv.acInVol': 49999, plugInInfoAcInFeq: 50, plugInInfoAcInFlag: 1 })).toEqual(conflict);
  // Voltage on is unaffected; frequency 0, a skipped 0–40 Hz or garbage frequency leaves voltage off as off.
  expect(detectGrid({ 'inv.acInVol': 229345, 'inv.acInFreq': 0 })).toEqual({ power: 'on', detail: 'на вході 229 В' });
  expect(detectGrid({ 'inv.acInVol': 0, 'inv.acInFreq': 0 })).toEqual({ power: 'off', detail: 'на вході 0 В' });
  expect(detectGrid({ 'inv.acInVol': 0, 'inv.acInFreq': 30 })).toEqual({ power: 'off', detail: 'на вході 0 В' });
  expect(detectGrid({ 'inv.acInVol': 0, 'inv.acInFreq': '50' })).toEqual({ power: 'off', detail: 'на вході 0 В' });
});
