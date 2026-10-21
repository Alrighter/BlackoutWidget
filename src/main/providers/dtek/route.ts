import type { Address, ScheduleSnapshot } from '../../../shared/types';
import { loggable } from '../http-source';
import { snapshotOf } from '../snapshot';
import { CaptchaRequiredError } from '../types';
import type { FeedAnswer } from './feeds';
import { queueLabelFromId } from './parse';

/** `at` (ms) is between 0 and `ms` ago. An unreadable stamp (NaN) or one in the future is not. */
const within = (at: number, ms: number): boolean => {
  const age = Date.now() - at;
  return age >= 0 && age < ms;
};

/** Spec step 1: no check on record, one not between 0 and `checkMs` ago, or an outage at the last check (re-checked within the budget). */
export function houseCheckDue(previous: ScheduleSnapshot | null, checkMs: number): boolean {
  if (!previous?.houseCheckedAt || previous.outageActive) return true;
  return !within(Date.parse(previous.houseCheckedAt), checkMs);
}

/** Spec «Settled cases»: a house missing from DTEK's answer is surfaced once no check succeeded within `surfaceMs` (or none is on record). */
export function houseMissingSurfaces(previous: ScheduleSnapshot | null, surfaceMs: number): boolean {
  return !within(Date.parse(previous?.houseCheckedAt ?? ''), surfaceMs);
}

/** Spec step 4: `previous` was fetched less than `gapMs` ago, so the page's next turn comes before it is old. */
export function keepPrevious(previous: ScheduleSnapshot | null, gapMs: number): previous is ScheduleSnapshot {
  return !!previous && within(Date.parse(previous.fetchedAt), gapMs);
}

/** The page budget: a page already open costs nothing; otherwise one open per `gapMs` (a clock set back waits it out). */
export function pageAllowed(open: boolean, lastOpenAt: number | null, gapMs: number): boolean {
  return open || lastOpenAt === null || Date.now() - lastOpenAt >= gapMs;
}

/** A page failure for the log: a verification as it is (its text is ours), anything else as `loggable` gives it. */
export const pageCause = (e: unknown): unknown => (e instanceof CaptchaRequiredError ? e : loggable(e));

/** Spec «A snapshot from a feed»: the days from the feed; the house's own data (lines, outage, check time) from `previous`. */
export function feedSnapshot(
  providerId: string, address: Address, previous: ScheduleSnapshot | null, answer: FeedAnswer,
): ScheduleSnapshot {
  const groupLabel = answer.groupLabel ?? previous?.groupLabel ?? queueLabelFromId(address.groupId);
  // No previous, no house data: the saved line alone, so no line change is invented.
  const lines = previous?.lines ?? [{ index: address.lineIndex, groupId: address.groupId, label: groupLabel }];
  return {
    ...snapshotOf({
      providerId, address, now: new Date(), groupLabel, lines, currentOutage: previous?.currentOutage,
      days: answer.days, sourceUpdatedAt: answer.sourceUpdatedAt, note: answer.note,
    }),
    ...(previous?.outageActive !== undefined ? { outageActive: previous.outageActive } : {}),
    ...(previous?.houseCheckedAt ? { houseCheckedAt: previous.houseCheckedAt } : {}),
  };
}
