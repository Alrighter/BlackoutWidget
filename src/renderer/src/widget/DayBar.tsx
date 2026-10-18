import type { CSSProperties } from 'react';
import type { StripPart } from '../../../shared/actual-view';
import type { DaySchedule, Slot } from '../../../shared/types';

const CELL_CLASS: Record<Slot, string> = { on: 'on', off: 'off', 'maybe-off': 'bw-cell--maybe', unknown: 'bw-cell--unknown' };

export interface DayCell {
  slot: Slot;
  /** The half hour is over (dimmed). */
  past: boolean;
  /** «off» only: where this cell starts and ends on its run's off-a → off-b gradient, 0..1. */
  offFrom?: number;
  offTo?: number;
}

/** The 48 half-hour cells of a day; a missing day is all unknown. `nowMin` (Kyiv minutes) dims what has passed. */
export function dayCells(slots: readonly Slot[] | null, nowMin?: number): DayCell[] {
  const at = (i: number): Slot => slots?.[i] ?? 'unknown';
  return Array.from({ length: 48 }, (_, i) => {
    const slot = at(i);
    const cell: DayCell = { slot, past: nowMin !== undefined && (i + 1) * 30 <= nowMin };
    if (slot === 'off') {
      let start = i;
      while (start > 0 && at(start - 1) === 'off') start--;
      let end = i;
      while (end < 47 && at(end + 1) === 'off') end++;
      const n = end - start + 1;
      cell.offFrom = (i - start) / n;
      cell.offTo = (i - start + 1) / n;
    }
    return cell;
  });
}

const pct = (f: number): string => `${Math.round(f * 1000) / 10}%`;

/**
 * A day strip: 48 half-hour cells, the actual power line under them and the «now» marker across both.
 * `nowFraction` (today only) dims the past cells and draws the marker. Without a day the cells are hatched unknown, or,
 * with `emptyText`, a bar with that text.
 */
export function DayBar({ day, nowFraction, actual, emptyText }: {
  day: DaySchedule | null; nowFraction?: number; actual?: StripPart[]; emptyText?: string;
}) {
  if (!day && emptyText) return <div className="w-strip"><div className="w-bar-empty"><span>{emptyText}</span></div></div>;
  const nowMin = nowFraction === undefined ? undefined : Math.round(nowFraction * 1440);
  return (
    <div className="w-strip" data-capture="strip">
      <div className="w-cells">
        {dayCells(day?.slots ?? null, nowMin).map((c, i) => (
          <span key={i} data-slot={c.slot} className={`w-cell ${CELL_CLASS[c.slot]}${c.past ? ' bw-cell--past' : ''}`}
            style={c.offFrom === undefined ? undefined
              : { '--off-from': pct(c.offFrom), '--off-to': pct(c.offTo ?? 1) } as CSSProperties} />
        ))}
      </div>
      {actual?.length ? <ActualLine parts={actual} /> : null}
      {nowMin !== undefined && <div className="w-now" style={{ left: `${(nowMin / 1440) * 100}%` }} />}
    </div>
  );
}

/** Thin line under today's cells: what the power actually was (on / off / unknown), in % of the 1440-minute day. */
export function ActualLine({ parts }: { parts: StripPart[] }) {
  return (
    <div className="w-actual-line">
      {parts.map((p, i) => (
        <span key={i} data-actual-part={p.power} className={`w-ap ${p.power}`}
          style={{ left: `${(p.startMin / 1440) * 100}%`, width: `${((p.endMin - p.startMin) / 1440) * 100}%` }} />
      ))}
    </div>
  );
}

export function DayTicks() {
  return <div className="w-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>;
}
