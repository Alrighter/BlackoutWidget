import type { Slot } from '../../../shared/types';
import { slotRuns, type WidgetView } from '../../../shared/widget-state';
import { Caption } from './parts';

const R = 80;
const C = 2 * Math.PI * R; // 502.65
const DOT: Record<WidgetView['state'], string> = { on: '#5dffa8', off: '#ff6b5b', 'maybe-off': '#ffc23d', unknown: '#9aa0b4', emergency: '#ff4d4d' };

function Arc({ start, end, slot }: { start: number; end: number; slot: Slot }) {
  const len = ((end - start) / 48) * C;
  const rot = (start / 48) * 360 - 90;
  return (
    <circle cx="100" cy="100" r={R} fill="none" strokeWidth="14" strokeLinecap="round"
      stroke={slot === 'off' ? 'url(#w-og)' : 'rgba(255,194,61,0.5)'}
      strokeDasharray={`${len} ${C}`}
      transform={`rotate(${rot} 100 100)`} data-arc={slot} />
  );
}

/** Estimated text width vs the room inside the ring: squeeze with textLength instead of overlapping the stroke. */
function fit(text: string, size: number, maxW: number): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  return text.length * size * 0.52 > maxW ? { textLength: maxW, lengthAdjust: 'spacingAndGlyphs' } : {};
}

/** Inner arc for a stretch of the day with actual outage (Kyiv minutes of 0..1440). */
function ActualArc({ startMin, endMin }: { startMin: number; endMin: number }) {
  const r = R - 12;
  const c = 2 * Math.PI * r;
  return (
    <circle cx="100" cy="100" r={r} fill="none" stroke="#ff6b5b" strokeWidth="3" strokeLinecap="round"
      strokeDasharray={`${((endMin - startMin) / 1440) * c} ${c}`}
      transform={`rotate(${(startMin / 1440) * 360 - 90} 100 100)`} data-actual-arc="off" />
  );
}

export function RingWidget({ view, lineChanged }: { view: WidgetView; lineChanged: boolean }) {
  const runs = view.today ? slotRuns(view.today.slots).filter(r => r.slot === 'off' || r.slot === 'maybe-off') : [];
  const a = view.nowFraction * 2 * Math.PI - Math.PI / 2;
  const nx = 100 + R * Math.cos(a), ny = 100 + R * Math.sin(a);
  const titleSize = view.title.length > 12 ? 12 : 17;
  const titleX = 106;
  const dotX = titleX - (view.title.length * titleSize * 0.52) / 2 - 10;
  const lines = view.countdownShort ? [] : view.nextText.split(' · ');
  const badgeY = view.countdownShort ? 139 : 133;
  const badgeW = view.outageBadge ? view.outageBadge.length * 6.2 + 16 : 0;
  return (
    <>
      {/* With the line-changed warning below, the empty margins above/below the ring are trimmed to make room. */}
      <svg viewBox={lineChanged ? '0 6 200 188' : '0 0 200 200'} width="204" height={lineChanged ? 192 : 204} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="w-og" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffc23d" /><stop offset="1" stopColor="#ff7a1a" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r={R} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="14" />
        {runs.map(r => <Arc key={r.start} start={r.start} end={r.end} slot={r.slot} />)}
        {view.actualStrip?.filter(p => p.power === 'off').map(p => <ActualArc key={p.startMin} startMin={p.startMin} endMin={p.endMin} />)}
        {view.today && <circle cx={nx} cy={ny} r="6" fill="#fff" style={{ filter: 'drop-shadow(0 0 4px #fff)' }} />}
        <g fontSize="10" textAnchor="middle" className="w-svg-label">
          <text x="100" y="42">00</text><text x="160" y="104">06</text><text x="100" y="166">12</text><text x="40" y="104">18</text>
        </g>
        <g textAnchor="middle" className="w-svg-main">
          <circle cx={dotX} cy={88 - titleSize * 0.35} r="4" fill={DOT[view.state]} />
          <text x={titleX} y="88" fontSize={titleSize} fontWeight="650" {...fit(view.title, titleSize, 112)}>{view.title}</text>
          {view.countdownShort ? (
            <>
              <text x="100" y="116" fontSize="24" fontWeight="650">{view.countdownShort}</text>
              <text x="100" y="131" fontSize="10" className="w-svg-sub" {...fit(view.countdownCaption ?? '', 10, 124)}>{view.countdownCaption}</text>
            </>
          ) : lines.map((l, i) => (
            <text key={i} x="100" y={114 + i * 14} fontSize="10" className="w-svg-sub" {...fit(l, 10, 124)}>{l}</text>
          ))}
        </g>
        {(view.actual || view.actualUnknownReason !== undefined) && (
          // Above the title, in the free space inside the ring.
          <g data-actual={view.actual ? 'live' : 'unknown'} transform="translate(95 55) scale(1)"
            style={view.actual ? { color: '#5dffa8' } : { color: 'var(--bw-ink-3)', opacity: 0.7 }}>
            <title>{view.actual ? 'Фактичний стан · EcoFlow' : `EcoFlow: ${view.actualUnknownReason}`}</title>
            <path d="M6 0 0 8h4l-1 6 7-9H6z" fill="currentColor" />
          </g>
        )}
        {view.outageBadge && (
          <g textAnchor="middle">
            <rect x={100 - badgeW / 2} y={badgeY} width={badgeW} height="17" rx="8.5" fill="rgba(255,77,77,0.85)" />
            <text x="100" y={badgeY + 12} fontSize="10.5" fontWeight="650" fill="#fff">{view.outageBadge}</text>
          </g>
        )}
      </svg>
      <div className="w-ring-caption">
        <Caption view={view} footWarning={lineChanged} updated={view.updatedText}
          label={lineChanged ? undefined : view.lineLabel.split(' · ')[0]} />
      </div>
    </>
  );
}
