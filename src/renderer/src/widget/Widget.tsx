import type { AppState, WidgetBackground } from '../../../shared/types';
import { kyivDateKey } from '../../../shared/time';
import { computeWidgetView, type WidgetView } from '../../../shared/widget-state';
import { CompactWidget } from './CompactWidget';
import { RingWidget } from './RingWidget';
import { TimelineWidget } from './TimelineWidget';

const emptyView = (now: Date): WidgetView => ({
  state: 'unknown', title: 'Немає даних', nextText: 'Графік ще не отримано',
  todayKey: kyivDateKey(now), today: null, tomorrow: null, nowFraction: 0,
  lineLabel: '', updatedText: '', stale: false,
});

/** Purely presentational; fills its window exactly (the window is transparent, the rounded card is the visible shape). */
export function Widget({ state, now, background }: { state: AppState; now: Date; background: WidgetBackground }) {
  const style = state.settings.widgetStyle;

  let body;
  if (!state.settings.address) {
    body = <div className="w-status"><span>Налаштуйте адресу</span></div>;
  } else {
    const view = state.snapshot ? computeWidgetView(state.snapshot, now) : emptyView(now);
    const props = { view, lineChanged: state.lineChanged };
    body = style === 'ring' ? <RingWidget {...props} /> : style === 'timeline' ? <TimelineWidget {...props} /> : <CompactWidget {...props} />;
  }
  return (
    <div className={`w-card w-${style} w-bg-${background.kind}`}>
      {background.kind === 'image' && <div className="w-bg" style={{ backgroundImage: `url("${background.dataUrl}")` }} />}
      <div className="w-tint" />
      <div className="w-content">{body}</div>
    </div>
  );
}
