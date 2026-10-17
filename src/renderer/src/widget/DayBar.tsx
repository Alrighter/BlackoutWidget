import type { DaySchedule, Slot } from '../../../shared/types';

const CLASS: Record<Slot, string> = { on: 'on', off: 'off', 'maybe-off': 'maybe', unknown: 'unk' };

/** 24 hour cells, each split into two half-hour slots. `day === null` means not published yet. */
export function DayBar({ day, nowFraction }: { day: DaySchedule | null; nowFraction?: number }) {
  if (!day) return <div className="w-bar w-bar-empty"><span>ще не опубліковано</span></div>;
  return (
    <div className="w-bar">
      {Array.from({ length: 24 }, (_, h) => (
        <div className="w-hour" key={h}>
          {[0, 1].map(k => {
            const slot = day.slots[h * 2 + k] ?? 'unknown';
            return <span key={k} data-slot={slot} className={`w-half ${CLASS[slot]}`} />;
          })}
        </div>
      ))}
      {nowFraction !== undefined && <div className="w-now" style={{ left: `calc(${nowFraction * 100}% - 1px)` }} />}
    </div>
  );
}

export function DayTicks() {
  return <div className="w-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>;
}
