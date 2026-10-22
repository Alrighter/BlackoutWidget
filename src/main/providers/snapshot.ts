import type { Address, CurrentOutage, DaySchedule, LineInfo, ScheduleSnapshot } from '../../shared/types';
import type { Logger } from '../log';
import { loggable } from './http-source';
import { NONE_GROUP, daySlots } from './lines';
import { AddressNotFoundError } from './resolve';

export interface ScheduleDays { days: DaySchedule[]; sourceUpdatedAt?: string; note?: string }

/** The spec's line rules: the saved queue not in `lines` → today 'unknown'; the 'none' line → today 'on'; else `schedule()`. */
export async function daysForLine(
  lines: readonly LineInfo[], groupId: string, today: string, schedule: () => Promise<ScheduleDays>,
): Promise<ScheduleDays> {
  // The operator moved the house to another queue: the app asks to pick the line again.
  if (!lines.some((l) => l.groupId === groupId)) return { days: [{ date: today, slots: daySlots('unknown') }] };
  if (groupId === NONE_GROUP) return { days: [{ date: today, slots: daySlots('on') }] };
  return schedule();
}

/** The snapshot; optional fields only when set (no `sourceUpdatedAt: undefined` keys). */
export function snapshotOf(
  p: { providerId: string; address: Address; now: Date; groupLabel: string; lines: LineInfo[]; currentOutage?: CurrentOutage } & ScheduleDays,
): ScheduleSnapshot {
  return {
    providerId: p.providerId,
    address: p.address,
    groupId: p.address.groupId,
    groupLabel: p.groupLabel,
    days: p.days,
    ...(p.sourceUpdatedAt ? { sourceUpdatedAt: p.sourceUpdatedAt } : {}),
    fetchedAt: p.now.toISOString(),
    lines: p.lines,
    ...(p.currentOutage ? { currentOutage: p.currentOutage } : {}),
    ...(p.note ? { note: p.note } : {}),
  };
}

/**
 * A refresh's address step. AddressNotFoundError always rethrows (a list read successfully lacks the saved entry); for the
 * 'none' line, which has no schedule behind it, any failure rethrows; otherwise the failure only costs the check: it is
 * logged and the saved line stays (undefined).
 */
export async function addressSide<T>(groupId: string, log: Logger, what: string, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (e) {
    if (e instanceof AddressNotFoundError || groupId === NONE_GROUP) throw e;
    log.warn(`${what} failed, keeping the saved line`, loggable(e));
    return undefined;
  }
}

/** A step that never fails the snapshot: log.warn(`${what} failed`, loggable(e)) and undefined. */
export async function bestEffort<T>(log: Logger, what: string, step: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await step();
  } catch (e) {
    log.warn(`${what} failed`, loggable(e));
    return undefined;
  }
}
