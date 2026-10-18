import type { Slot } from './types';
import { slotRuns } from './widget-state';

/** «HH:MM» at the start of half-hour slot `i` (48 is «24:00»). */
const slotHM = (i: number) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;

/** A day's planned outages as «HH:MM–HH:MM», a possible one marked « (можливо)» (the schedule tab, the wizard). */
export function outageRanges(slots: Slot[]): string[] {
  return slotRuns(slots)
    .filter(r => r.slot === 'off' || r.slot === 'maybe-off')
    .map(r => `${slotHM(r.start)}–${slotHM(r.end)}${r.slot === 'maybe-off' ? ' (можливо)' : ''}`);
}
