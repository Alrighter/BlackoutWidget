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

/** A queue value of a shape we do not know. The message is fixed: it never carries the value (a response's text). */
export class QueueValueError extends Error {
  override name = 'QueueValueError';
  constructor() {
    super('unknown queue value');
  }
}

/**
 * One queue value as an operator writes it: «N.M» (trimmed) is that queue id; a value of the provider's own list of
 * «not in the schedule» values (matched exactly) is NONE_GROUP; anything else throws QueueValueError, which the caller
 * reads as «could not read», never as the always-on line.
 */
export function classifyQueue(value: unknown, notInSchedule: readonly (string | null)[]): string {
  if (typeof value === 'string' && QUEUE.test(value.trim())) return value.trim();
  if ((typeof value === 'string' || value === null) && notInSchedule.includes(value)) return NONE_GROUP;
  throw new QueueValueError();
}

/**
 * The lines of classified ids (`classifyQueue`, or ids already known to be N.M): the distinct queues, sorted
 * numerically (1.2 < 2.1 < 10.1), index from 1; no queue among them → [the 'none' line].
 */
export function linesOf(groupIds: readonly string[]): LineInfo[] {
  const queues = [...new Set(groupIds.filter(g => QUEUE.test(g)))].sort(byQueue);
  const ids = queues.length ? queues : [NONE_GROUP];
  return ids.map((groupId, i) => ({ index: i + 1, groupId, label: queueLabel(groupId) }));
}

export const daySlots = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
