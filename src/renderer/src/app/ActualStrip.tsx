import type { StripPart } from '../../../shared/actual-view';

/** Today's actual power on the same 24-hour scale as DayStrip (% of the 1440-minute day). */
export function ActualStrip({ parts }: { parts: StripPart[] }) {
  return (
    <div className="actual-strip">
      {parts.map((p, i) => (
        <span key={i} data-actual-part={p.power} className={`actual-part ${p.power}`}
          style={{ left: `${(p.startMin / 1440) * 100}%`, width: `${((p.endMin - p.startMin) / 1440) * 100}%` }} />
      ))}
    </div>
  );
}
