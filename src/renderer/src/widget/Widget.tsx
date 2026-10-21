import type { ReactNode } from 'react';
import { providerDisplayName } from '../../../shared/providers';
import type { WidgetState, WidgetBackground } from '../../../shared/types';
import { kyivDateKey, kyivMinutesOfDay } from '../../../shared/time';
import { computeWidgetView, type WidgetView } from '../../../shared/widget-state';
import { CompactWidget } from './CompactWidget';
import { RingWidget } from './RingWidget';
import { TimelineWidget } from './TimelineWidget';

const emptyView = (now: Date): WidgetView => ({
  state: 'unknown', title: 'Немає даних', nextText: 'Графік ще не отримано',
  todayKey: kyivDateKey(now), today: null, tomorrow: null, nowFraction: kyivMinutesOfDay(now) / 1440,
  lineLabel: '', updatedText: '', stale: false,
});

/**
 * Purely presentational; fills its window exactly (the window is transparent, the rounded card is the visible shape).
 * Layers: the blurred wallpaper under the window (or the theme's solid underlay), the glass tinted by the state, content,
 * and `children` over it all (move mode), clipped to the card.
 */
export function Widget({ state, now, background, children }: {
  state: WidgetState; now: Date; background: WidgetBackground; children?: ReactNode;
}) {
  const { location: loc, showName } = state;
  const style = loc.location.widgetStyle;
  const view = loc.snapshot ? computeWidgetView(loc.snapshot, now, loc.actual) : emptyView(now);
  // The name leads the caption only among several locations; before the first schedule it is all the caption has.
  const props = { view, lineChanged: loc.lineChanged, name: showName ? loc.location.name : '' };
  // From the snapshot the line label comes from; before the first one there is no line or provider.
  const provider = loc.snapshot ? providerDisplayName(loc.snapshot.providerId) : '';
  const body = style === 'ring' ? <RingWidget {...props} />
    : style === 'timeline' ? <TimelineWidget {...props} provider={provider} />
    : <CompactWidget {...props} />;
  return (
    <div className={`w-card w-${style} w-bg-${background.kind} w-tone-${view.state}`}>
      {background.kind === 'image' && <div className="w-bg" style={{ backgroundImage: `url("${background.dataUrl}")` }} />}
      <div className="w-glass" />
      <div className="w-content">{body}</div>
      {children}
    </div>
  );
}
