import type { AppState, WidgetBackground } from '../../../shared/types';
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
 * Layers: the blurred wallpaper under the window (or the theme's solid underlay), the glass tinted by the state, content.
 */
export function Widget({ state, now, background }: { state: AppState; now: Date; background: WidgetBackground }) {
  const style = state.settings.widgetStyle;
  const view = !state.settings.address ? null : state.snapshot ? computeWidgetView(state.snapshot, now, state.actual) : emptyView(now);

  let body;
  if (!view) {
    body = <div className="w-status"><span>Налаштуйте адресу</span></div>;
  } else {
    const props = { view, lineChanged: state.lineChanged };
    body = style === 'ring' ? <RingWidget {...props} /> : style === 'timeline' ? <TimelineWidget {...props} /> : <CompactWidget {...props} />;
  }
  return (
    <div className={`w-card w-${style} w-bg-${background.kind} w-tone-${view?.state ?? 'unknown'}`}>
      {background.kind === 'image' && <div className="w-bg" style={{ backgroundImage: `url("${background.dataUrl}")` }} />}
      <div className="w-glass" />
      <div className="w-content">{body}</div>
    </div>
  );
}
