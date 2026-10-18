import type { CSSProperties } from 'react';
import type { StripPart } from '../../../shared/actual-view';
import type { WidgetView } from '../../../shared/widget-state';
import { dayCells, type DayCell } from './DayBar';
import { OutageBadge } from './OutageBadge';
import { Caption, countdownText, EcoBolt, StateDot, Status, WarnLine } from './parts';

/** Ring diameter; under the line-changed warning row it shrinks to make room (widget-ring.html). */
const RING = 208;
const RING_SMALL = 184;
/** Empty ring at each end of a half hour (7.5°). */
const GAP = 0.7;
const STRIPE = (7.5 - 2 * GAP) / 4;

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;
const deg = (d: number): string => `${round(d, 2)}deg`;
/** A colour at an alpha: a half hour that is over keeps 0.4 of it. */
const alpha = (color: string, a: number): string => (a === 1 ? color : `rgb(from ${color} r g b / ${round(a, 3)})`);
const offMix = (f: number): string => `color-mix(in srgb, var(--bw-off-a), var(--bw-off-b) ${round(f * 100, 3)}%)`;

export interface SegmentPaint { stripes: boolean; c0: string; c1: string }

/** How a half hour is painted: a gradient c0 → c1 along it, or (maybe, unknown) four bands c0 / c1 / c0 / c1. */
export function segmentPaint(cell: DayCell): SegmentPaint {
  const a = cell.past ? 0.4 : 1;
  const solid = (color: string): SegmentPaint => ({ stripes: false, c0: alpha(color, a), c1: alpha(color, a) });
  if (cell.emergency) return solid('var(--bw-emergency)');
  switch (cell.slot) {
    case 'on': return solid('var(--bw-on)');
    case 'off': return { stripes: false, c0: alpha(offMix(cell.offFrom ?? 0), a), c1: alpha(offMix(cell.offTo ?? 1), a) };
    case 'maybe-off': return { stripes: true, c0: alpha('var(--bw-maybe)', a), c1: alpha('var(--bw-maybe)', 0.28 * a) };
    default: return { stripes: true, c0: alpha('var(--bw-unknown)', 0.85 * a), c1: alpha('var(--bw-unknown)', 0.22 * a) };
  }
}

/** The day's 48 half hours as one conic gradient: 00 at the top, clockwise. */
export function ringGradient(cells: DayCell[]): string {
  const stops: string[] = [];
  cells.forEach((cell, i) => {
    const from = i * 7.5, to = from + 7.5, p = segmentPaint(cell);
    stops.push(`transparent ${deg(from)} ${deg(from + GAP)}`);
    if (p.stripes) {
      for (let k = 0; k < 4; k++) {
        const x = from + GAP + k * STRIPE;
        stops.push(`${k % 2 ? p.c1 : p.c0} ${deg(x)} ${deg(x + STRIPE)}`);
      }
    } else {
      stops.push(`${p.c0} ${deg(from + GAP)}`, `${p.c1} ${deg(to - GAP)}`);
    }
    stops.push(`transparent ${deg(to - GAP)} ${deg(to)}`);
  });
  return `conic-gradient(${stops.join(', ')})`;
}

/** What the power actually was today, for the inner ring (minutes / 4 = degrees): on, off, unknown dashed. */
export function actualGradient(parts: StripPart[]): string {
  const stops: string[] = [];
  let at = 0;
  for (const p of parts) {
    const from = p.startMin / 4, to = p.endMin / 4;
    if (from > at) stops.push(`transparent ${deg(at)} ${deg(from)}`);
    if (p.power === 'unknown') {
      for (let x = from; x < to; x += 3) {
        const dash = Math.min(x + 1.5, to), gap = Math.min(x + 3, to);
        stops.push(`rgb(from var(--bw-unknown) r g b / 0.95) ${deg(x)} ${deg(dash)}`);
        if (gap > dash) stops.push(`transparent ${deg(dash)} ${deg(gap)}`);
      }
    } else {
      stops.push(`${p.power === 'on' ? 'rgb(from var(--bw-on) r g b / 0.75)' : 'var(--bw-off-dot)'} ${deg(from)} ${deg(to)}`);
    }
    at = to;
  }
  if (at < 360) stops.push(`transparent ${deg(at)} 360deg`);
  return `conic-gradient(${stops.join(', ')})`;
}

/** Centre of the «now» dot: on the middle of the 12 px band, at the clock's angle. */
function nowDot(size: number, nowFraction: number): CSSProperties {
  const angle = nowFraction * 2 * Math.PI, r = size / 2 - 6;
  return { left: `${(size / 2 + r * Math.sin(angle)).toFixed(1)}px`, top: `${(size / 2 - r * Math.cos(angle)).toFixed(1)}px` };
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function RingWidget({ view, lineChanged }: { view: WidgetView; lineChanged: boolean }) {
  const size = lineChanged ? RING_SMALL : RING;
  const cells = dayCells(view.today?.slots ?? null, Math.round(view.nowFraction * 1440), view.emergency);
  const actual = view.actualStrip?.length ? view.actualStrip : null;
  // On a mismatch the caption already carries «з HH:MM».
  const since = view.actual && !view.actual.mismatch ? view.actual.sinceText : undefined;
  const badge = view.outageBadge && <OutageBadge text={view.outageBadge} />;
  const count = countdownText(view);
  return (
    <>
      <div className={lineChanged ? 'w-dial w-dial-small' : 'w-dial'} style={{ width: size, height: size }} data-capture="dial">
        <div className="w-dial-segs" style={{ '--w-segs': ringGradient(cells) } as CSSProperties} />
        {actual && (
          <>
            <div className="w-dial-actual w-dial-track" />
            <div className="w-dial-actual" data-actual-arc style={{ '--w-actual': actualGradient(actual) } as CSSProperties} />
          </>
        )}
        <span className="w-dial-tick w-at-00" data-capture="tick00">00</span>
        <span className="w-dial-tick w-at-06">06</span>
        <span className="w-dial-tick w-at-12" data-capture="tick12">12</span>
        <span className="w-dial-tick w-at-18">18</span>
        {/* Not before the first schedule arrives (no «оновлено» yet). */}
        {view.updatedText !== '' && <div className="w-dial-now" data-capture="now" style={nowDot(size, view.nowFraction)} />}
        {count ? (
          <div className="w-dial-center" data-capture="center">
            {badge}
            <Status view={view} since={since} inlineBadge={false} tipAbove />
            <div className={count.length > 5 ? 'w-dial-count w-dial-count-long' : 'w-dial-count'} data-capture="count">{count}</div>
            <div className="w-dial-cap" title={view.countdownCaption} data-capture="dialcap">{view.countdownCaption}</div>
          </div>
        ) : (
          <div className="w-dial-center w-dial-nocount" data-capture="center">
            <div className="w-dial-marks"><StateDot state={view.state} /><EcoBolt view={view} tipAbove /></div>
            {badge}
            <div className="w-dial-title" title={view.title} data-capture="status">{view.title}</div>
            <div className="w-dial-cap" title={view.nextText} data-capture="dialcap">{lowerFirst(view.nextText)}</div>
          </div>
        )}
      </div>
      <div className="w-spacer" />
      {lineChanged && <WarnLine />}
      <Caption view={view} label={view.lineLabel} updated={view.updatedText} />
    </>
  );
}
