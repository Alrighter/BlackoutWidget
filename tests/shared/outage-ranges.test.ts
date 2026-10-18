import { outageRanges } from '../../src/shared/outage-ranges';
import type { Slot } from '../../src/shared/types';

/** 48 «on» slots with [fromHour, toHour, slot] spans painted over. */
function day(spans: [number, number, Slot][]): Slot[] {
  const slots = new Array<Slot>(48).fill('on');
  for (const [from, to, slot] of spans) for (let i = from * 2; i < to * 2; i++) slots[i] = slot;
  return slots;
}

test('lists the off and possible runs in order, a possible one marked, the last one ending at 24:00', () => {
  expect(outageRanges(day([[4, 7.5, 'off'], [12, 16, 'maybe-off'], [20, 24, 'off']])))
    .toEqual(['04:00–07:30', '12:00–16:00 (можливо)', '20:00–24:00']);
});

test('unknown slots and a day without outages give nothing', () => {
  expect(outageRanges(day([[0, 6, 'unknown']]))).toEqual([]);
  expect(outageRanges(day([]))).toEqual([]);
});
