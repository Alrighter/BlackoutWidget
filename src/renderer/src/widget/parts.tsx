import { useLayoutEffect, useRef, useState } from 'react';
import type { PowerState, WidgetView } from '../../../shared/widget-state';
import { OutageBadge } from './OutageBadge';

/** State dot with its glow, in the state's colour (`w-tone-*` sets `--bw-state`). */
export function StateDot({ state }: { state: PowerState }) {
  return <span className={`w-dot w-tone-${state}`} />;
}

const BOLT = 'M13.5 2 4.5 13.5H11l-1.5 8.5 9-11.5H12z';

/**
 * Below the bolt (the window ends just above it) the tooltip starts 14 px left of it; above it (ring) it is centred on
 * it, as in the mockups. Either way it is kept 8 px inside the card.
 */
function placeTip(bolt: HTMLElement, tip: HTMLElement, above: boolean) {
  const card = (bolt.closest('.w-card') ?? document.documentElement).getBoundingClientRect();
  const b = bolt.getBoundingClientRect();
  const width = tip.getBoundingClientRect().width;
  const want = above ? b.left + b.width / 2 - width / 2 : b.left - 14;
  const left = Math.max(card.left + 8, Math.min(want, card.right - 8 - width));
  tip.style.left = `${left - b.left}px`;
}

/** The EcoFlow bolt shows: a live reading, or a source that is silent. */
const hasBolt = (view: WidgetView): boolean => !!view.actual || view.actualUnknownReason !== undefined;

/**
 * Which source the state comes from: a bolt when it is the live EcoFlow reading, a hollow muted one when the source is
 * silent. Hover or focus shows the tooltip, below the bolt or, with `tipAbove`, above it.
 */
export function EcoBolt({ view, tipAbove = false }: { view: WidgetView; tipAbove?: boolean }) {
  const [open, setOpen] = useState(false);
  const bolt = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  // Every render while open: a new title or badge moves the bolt.
  useLayoutEffect(() => {
    if (open && bolt.current && tip.current) placeTip(bolt.current, tip.current, tipAbove);
  });
  if (!hasBolt(view)) return null;
  const unknown = view.actualUnknownReason !== undefined;
  const text = unknown ? `EcoFlow: ${view.actualUnknownReason}` : 'Фактичний стан · EcoFlow';
  const show = () => setOpen(true);
  const hide = () => setOpen(false);
  return (
    <span className="w-eco">
      <span ref={bolt} className={unknown ? 'w-bolt w-bolt-unk' : 'w-bolt'} data-actual={unknown ? 'unknown' : 'live'}
        role="img" aria-label={text} tabIndex={0} onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}
        // A press (click, drag) must not focus it, or the tooltip would stay open: focus is for the keyboard.
        onMouseDown={e => e.preventDefault()}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d={BOLT} /></svg>
      </span>
      {open && (
        <span ref={tip} className={tipAbove ? 'w-tip w-tip-above' : 'w-tip'} role="tooltip" data-capture="tip">{text}</span>
      )}
    </span>
  );
}

/**
 * Status row: dot, title, outage badge, EcoFlow bolt and, when given, «з HH:MM». The title outranks the rest, so with
 * an outage badge «з HH:MM» is left out: the row has no room for both. A long title beside the bolt is marked
 * `w-long`, so the compact can set it a step smaller. The ring sets the badge above the row itself
 * (`inlineBadge={false}`) and opens the tooltip above the bolt.
 */
export function Status({ view, since, inlineBadge = true, tipAbove = false }: {
  view: WidgetView; since?: string; inlineBadge?: boolean; tipAbove?: boolean;
}) {
  return (
    <div className={view.title.length > 14 && hasBolt(view) ? 'w-status w-long' : 'w-status'}>
      <StateDot state={view.state} />
      <span className="w-title w-ellipsis" title={view.title} data-capture="status">{view.title}</span>
      {inlineBadge && view.outageBadge && <OutageBadge text={view.outageBadge} />}
      <EcoBolt view={view} tipAbove={tipAbove} />
      {since && !view.outageBadge && <span className="w-since">{since}</span>}
    </div>
  );
}

const WARNING = 'Схема підключення змінилась — перевірте лінію';

/** The line-changed warning as a row of its own, with a triangle. */
export function WarnLine() {
  return (
    <div className="w-warnline w-cap-warn" title={WARNING} data-capture="warn">
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 2 20.5h20z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" />
      </svg>
      <span className="w-ellipsis">{WARNING}</span>
    </div>
  );
}

/** The caption's label: the location's name (only among several locations) before the line. */
export const captionLabel = (...parts: string[]): string => parts.filter(Boolean).join(' · ');

/**
 * Footer, one row always kept inside the fixed window: «оновлено HH:MM» and the stale pill never shrink, only the
 * optional label before them ellipsizes.
 */
export function Caption({ view, label, updated }: { view: WidgetView; label?: string; updated: string }) {
  if (!updated && !label) return null;
  const title = [label, updated, view.stale ? 'дані застаріли' : ''].filter(Boolean).join(' · ');
  return (
    <div className="w-foot">
      <div className="w-cap" title={title} data-capture="caption">
        {label && <span className="w-ellipsis" data-capture="label">{label}</span>}
        {label && updated && <span className="w-sep"> · </span>}
        {updated && <span className="w-fixed" data-capture="updated">{updated}</span>}
        {view.stale && <span className="w-stale" data-capture="stale">дані застаріли</span>}
      </div>
    </div>
  );
}
