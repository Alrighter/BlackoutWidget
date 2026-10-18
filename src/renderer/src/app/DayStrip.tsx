import type { CSSProperties } from 'react';
import type { DayCell } from '../../../shared/day-cells';
import type { Slot } from '../../../shared/types';

const KIND: Record<Slot, string> = { on: 'on', off: 'off', 'maybe-off': 'maybe', unknown: 'unknown' };
const pct = (f: number): string => `${Math.round(f * 1000) / 10}%`;

/** 24 hour columns, each split into two half-hour cells (`dayCells`: past ones dimmed, emergency ones red). */
export function DayStrip({ cells }: { cells: DayCell[] }) {
  return (
    <div className="day-strip">
      {Array.from({ length: 24 }, (_, h) => (
        <div className="day-hour" key={h}>
          {[cells[h * 2], cells[h * 2 + 1]].map((c, i) => (
            <span key={i} data-cell={c.emergency ? 'emergency' : c.slot}
              className={`day-cell ${c.emergency ? 'emergency' : KIND[c.slot]}${c.past ? ' bw-cell--past' : ''}`}
              style={c.offFrom === undefined ? undefined
                : { '--off-from': pct(c.offFrom), '--off-to': pct(c.offTo ?? 1) } as CSSProperties} />
          ))}
        </div>
      ))}
    </div>
  );
}
