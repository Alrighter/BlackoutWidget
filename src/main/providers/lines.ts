import type { LineInfo, Slot } from '../../shared/types';

export const NONE_GROUP = 'none';
export const NOT_IN_SCHEDULE = 'Не входить до ГПВ';

export function queueLabel(groupId: string): string {
  return groupId === NONE_GROUP ? NOT_IN_SCHEDULE : `Черга ${groupId}`;
}

const QUEUE = /^\d+\.\d+$/;
const byQueue = (a: string, b: string): number => {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
};

/** Distinct queue ids (only /^\d+\.\d+$/), sorted numerically (1.2 < 2.1 < 10.1), index from 1; none left → [the 'none' line]. */
export function linesOf(groupIds: readonly string[]): LineInfo[] {
  const queues = [...new Set(groupIds.filter(g => QUEUE.test(g)))].sort(byQueue);
  const ids = queues.length ? queues : [NONE_GROUP];
  return ids.map((groupId, i) => ({ index: i + 1, groupId, label: queueLabel(groupId) }));
}

export const daySlots = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
