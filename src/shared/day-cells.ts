import type { Slot } from './types';
import type { WidgetView } from './widget-state';

export interface DayCell {
  slot: Slot;
  /** Inside the active emergency outage: solid red over the planned slot. */
  emergency: boolean;
  /** The half hour is over (dimmed). */
  past: boolean;
  /** «off» only: where this cell starts and ends on its run's off-a → off-b gradient, 0..1. */
  offFrom?: number;
  offTo?: number;
}

/**
 * The 48 half-hour cells of a day; a missing day is all unknown. `nowMin` (Kyiv minutes) dims what has passed; cells
 * overlapping `emergency` are emergency cells, and the planned off runs around them keep gradients of their own.
 */
export function dayCells(slots: readonly Slot[] | null, nowMin?: number, emergency?: WidgetView['emergency']): DayCell[] {
  const at = (i: number): Slot => slots?.[i] ?? 'unknown';
  const inEmergency = (i: number): boolean => !!emergency && i * 30 < emergency.endMin && (i + 1) * 30 > emergency.startMin;
  const off = (i: number): boolean => at(i) === 'off' && !inEmergency(i);
  return Array.from({ length: 48 }, (_, i) => {
    const slot = at(i);
    const cell: DayCell = { slot, emergency: inEmergency(i), past: nowMin !== undefined && (i + 1) * 30 <= nowMin };
    if (off(i)) {
      let start = i;
      while (start > 0 && off(start - 1)) start--;
      let end = i;
      while (end < 47 && off(end + 1)) end++;
      const n = end - start + 1;
      cell.offFrom = (i - start) / n;
      cell.offTo = (i - start + 1) / n;
    }
    return cell;
  });
}
