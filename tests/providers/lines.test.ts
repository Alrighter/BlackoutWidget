import { NONE_GROUP, NOT_IN_SCHEDULE, daySlots, linesOf, queueLabel } from '../../src/main/providers/lines';

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
