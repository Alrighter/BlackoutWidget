import { NONE_GROUP, NOT_IN_SCHEDULE, QueueValueError, classifyQueue, daySlots, linesOf, queueLabel } from '../../src/main/providers/lines';

describe('classifyQueue (final I2)', () => {
  const LVIV = ['Не входить'] as const;
  const TERNOPIL = ['Не входить', '', null] as const;

  test('an N.M queue is that id, trimmed', () => {
    expect(classifyQueue('5.1', LVIV)).toBe('5.1');
    expect(classifyQueue('5.1 ', LVIV)).toBe('5.1');
    expect(classifyQueue(' 10.2', TERNOPIL)).toBe('10.2');
  });
  test('a value of the provider\'s non-queue list is the always-on line', () => {
    expect(classifyQueue('Не входить', LVIV)).toBe(NONE_GROUP);
    expect(classifyQueue('Не входить', TERNOPIL)).toBe(NONE_GROUP);
    expect(classifyQueue('', TERNOPIL)).toBe(NONE_GROUP);
    expect(classifyQueue(null, TERNOPIL)).toBe(NONE_GROUP);
  });
  test('anything else throws, and the error never carries the value', () => {
    for (const [value, list] of [
      ['5.1, 5.2', TERNOPIL], ['Черга 1.2', LVIV], ['5', LVIV], ['5.1.1', LVIV], ['.1', LVIV], ['5.1;', LVIV],
      // Only the N.M rule trims: the non-queue list matches exactly.
      ['Не входить ', LVIV], ['не входить', TERNOPIL],
      // Lviv never writes an empty or null queue.
      ['', LVIV], [null, LVIV],
      [undefined, TERNOPIL], [5.1, TERNOPIL], [{}, TERNOPIL],
    ] as [unknown, readonly (string | null)[]][]) {
      let err: unknown;
      try { classifyQueue(value, list); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(QueueValueError);
      expect(err).toBeInstanceOf(Error);
      if (typeof value === 'string' && value !== '') expect((err as Error).message).not.toContain(value);
    }
  });
});

test('queue lines are distinct and indexed from 1', () => {
  expect(linesOf(['2.2', '4.1', '2.2'])).toEqual([
    { index: 1, groupId: '2.2', label: 'Черга 2.2' },
    { index: 2, groupId: '4.1', label: 'Черга 4.1' },
  ]);
});
test('no queue left gives the always-on line', () => {
  expect(linesOf(['Не входить', ''])).toEqual([{ index: 1, groupId: NONE_GROUP, label: 'Не входить до ГПВ' }]);
  expect(linesOf([])).toEqual([{ index: 1, groupId: 'none', label: NOT_IN_SCHEDULE }]);
});
test('queues sort numerically', () => {
  expect(linesOf(['10.1', '2.1', '1.2']).map(l => l.groupId)).toEqual(['1.2', '2.1', '10.1']);
});
test('queueLabel', () => {
  expect(queueLabel('none')).toBe(NOT_IN_SCHEDULE);
  expect(queueLabel('3.1')).toBe('Черга 3.1');
});
test('daySlots is 48 equal slots', () => {
  const s = daySlots('on');
  expect(s).toHaveLength(48);
  expect(new Set(s)).toEqual(new Set(['on']));
});
