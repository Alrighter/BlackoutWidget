import { describe, expect, it } from 'vitest';
import { BLE_LINK_TEXT, BLE_PREFIXES, BLE_PROBLEM_TEXT, BLE_REASON, isRiver2Family, type BleProblem } from '../../src/shared/ecoflow-ble';

describe('shared EcoFlow BLE vocabulary', () => {
  it('recognises the RIVER 2 family by SN prefix', () => {
    for (const p of BLE_PREFIXES) expect(isRiver2Family(`${p}ZEB4XXXX0000`)).toBe(true);
    for (const sn of ['R331ZEB4XXXX0000', 'D361ZEB4XXXX0000', '']) expect(isRiver2Family(sn)).toBe(false);
  });

  it('has a text for every problem', () => {
    const problems: BleProblem[] = ['bt-off', 'bt-denied', 'bt-missing', 'bt-unavailable', 'host-failed', 'scan-failed'];
    for (const p of problems) expect(BLE_PROBLEM_TEXT[p].length).toBeGreaterThan(0);
    for (const p of problems.filter(x => x !== 'scan-failed')) expect(BLE_REASON[p as Exclude<BleProblem, 'scan-failed'>].length).toBeGreaterThan(0);
    expect(Object.values(BLE_LINK_TEXT).every(t => t.length > 0)).toBe(true);
  });

  it('composes the silent-inverter reason', () => {
    expect(BLE_REASON.invSilent + BLE_REASON.acOffHint).toBe('станція не повідомляє про вхід (вимкнено вихід AC?)');
  });
});
