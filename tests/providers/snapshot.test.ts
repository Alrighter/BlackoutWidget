import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/main/log';
import { loggable } from '../../src/main/providers/http-source';
import { addressSide, bestEffort, daysForLine, snapshotOf } from '../../src/main/providers/snapshot';
import { AddressNotFoundError, addressNotFound } from '../../src/main/providers/resolve';
import { ProviderError } from '../../src/main/providers/types';
import type { Address, LineInfo } from '../../src/shared/types';

const TODAY = '2026-10-20';
const line = (groupId: string, label: string): LineInfo => ({ index: 1, groupId, label });
const QUEUE_1_2 = line('1.2', 'Черга 1.2');
const NONE = line('none', 'Не входить до ГПВ');
const slots = (s: string) => Array(48).fill(s);

describe('daysForLine', () => {
  it('a saved queue the house no longer has is unknown today, and the schedule is not asked', async () => {
    const schedule = vi.fn();
    const r = await daysForLine([QUEUE_1_2], '5.1', TODAY, schedule);
    expect(r).toEqual({ days: [{ date: TODAY, slots: slots('unknown') }] });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('the none line is on today, and the schedule is not asked', async () => {
    const schedule = vi.fn();
    const r = await daysForLine([NONE], 'none', TODAY, schedule);
    expect(r).toEqual({ days: [{ date: TODAY, slots: slots('on') }] });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a queue the house has gives the schedule as it is', async () => {
    const answer = { days: [{ date: TODAY, slots: slots('off') }], sourceUpdatedAt: '10:00 20.10.2026', note: 'n' };
    const r = await daysForLine([QUEUE_1_2], '1.2', TODAY, async () => answer);
    expect(r).toBe(answer);
  });
});

describe('snapshotOf', () => {
  const address: Address = { providerId: 'x', city: 'a', street: 'b', house: '1', lineIndex: 1, groupId: '1.2' };
  const base = {
    providerId: 'x', address, now: new Date('2026-10-20T10:00:00Z'), groupLabel: 'Черга 1.2', lines: [QUEUE_1_2],
    days: [{ date: TODAY, slots: slots('on') }],
  };

  it('has no optional keys unless they are set', () => {
    const s = snapshotOf(base);
    expect(Object.keys(s).sort()).toEqual(['address', 'days', 'fetchedAt', 'groupId', 'groupLabel', 'lines', 'providerId']);
    expect(s.groupId).toBe('1.2');
    expect(s.fetchedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('carries the optional fields that are set', () => {
    const currentOutage = { kind: 'emergency' as const, text: 'Аварія' };
    const s = snapshotOf({ ...base, sourceUpdatedAt: '10:00 20.10.2026', note: 'n', currentOutage });
    expect(s).toMatchObject({ sourceUpdatedAt: '10:00 20.10.2026', note: 'n', currentOutage });
  });
});

function logger() {
  const warn = vi.fn();
  const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
  return { log, warn };
}

describe('addressSide', () => {
  it('rethrows AddressNotFoundError for a queue line', async () => {
    const { log, warn } = logger();
    await expect(addressSide('1.2', log, 'step', async () => { throw addressNotFound('Х'); })).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows anything for the none line', async () => {
    const { log } = logger();
    await expect(addressSide('none', log, 'step', async () => { throw new ProviderError('down'); })).rejects.toThrow('down');
  });

  it('keeps the saved line for a queue line: undefined and one warning without response text', async () => {
    const { log, warn } = logger();
    const r = await addressSide('1.2', log, 'loe fetchSnapshot: address check', async () => { throw new Error('Замовник Петренко'); });
    expect(r).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('loe fetchSnapshot: address check failed, keeping the saved line', { error: 'Error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Петренко');
  });

  it('gives the step\'s answer when it works', async () => {
    const { log } = logger();
    expect(await addressSide('1.2', log, 'step', async () => 7)).toBe(7);
  });
});

describe('bestEffort', () => {
  it('logs the failure and gives undefined', async () => {
    const { log, warn } = logger();
    const e = new ProviderError('x');
    expect(await bestEffort(log, 'toe fetchSnapshot: current outage lookup', async () => { throw e; })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('toe fetchSnapshot: current outage lookup failed', loggable(e));
  });

  it('gives the step\'s answer when it works', async () => {
    expect(await bestEffort(logger().log, 'step', async () => 'ok')).toBe('ok');
  });
});
