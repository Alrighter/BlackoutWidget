import type { Slot } from '../../../shared/types';

const CLASS: Record<Slot, string> = { on: 'on', off: 'off', 'maybe-off': 'maybe', unknown: 'unknown' };

/** 24 hour columns, each split into two half-hour cells. */
export function DayStrip({ slots, labels = false }: { slots: Slot[]; labels?: boolean }) {
  return (
    <div className={`strip${labels ? ' strip-labeled' : ''}`}>
      {Array.from({ length: 24 }, (_, h) => (
        <div className="hour" key={h}>
          <div className="halves">
            <span className={`half ${CLASS[slots[h * 2] ?? 'unknown']}`} />
            <span className={`half ${CLASS[slots[h * 2 + 1] ?? 'unknown']}`} />
          </div>
          {labels && <span className="hour-label">{String(h).padStart(2, '0')}-{String(h + 1).padStart(2, '0')}</span>}
        </div>
      ))}
    </div>
  );
}
