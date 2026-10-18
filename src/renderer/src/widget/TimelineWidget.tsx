import { addDays, formatDM } from '../../../shared/time';
import type { WidgetView } from '../../../shared/widget-state';
import { DayBar, DayTicks } from './DayBar';
import { Caption, Status } from './parts';

export function TimelineWidget({ view, lineChanged }: { view: WidgetView; lineChanged: boolean }) {
  const tomorrowKey = view.tomorrow?.date ?? addDays(view.todayKey, 1);
  const updated = view.updatedText.charAt(0).toUpperCase() + view.updatedText.slice(1);
  const since = view.actual && !view.actual.mismatch ? view.actual.sinceText : undefined;
  const sub = since ? `${view.lineLabel} · ${since}` : view.lineLabel;
  return (
    <>
      <div className="w-tl-head">
        <div>
          <Status view={view} />
          <div className="w-muted w-tl-sub w-ellipsis" style={{ marginTop: 3 }} title={sub}>{sub}</div>
        </div>
        <div className="w-tl-count">
          {view.countdownShort ? (
            <>
              <div className="w-big">{view.countdownShort}</div>
              <div className="w-muted w-ellipsis" title={view.countdownCaption}>{view.countdownCaption}</div>
            </>
          ) : (
            <div className="w-muted w-tl-text w-ellipsis" title={view.nextText}>{view.nextText}</div>
          )}
        </div>
      </div>
      <div className="w-tl-row" style={{ marginTop: 14 }}>
        <div className="w-row-label">Сьогодні {formatDM(view.todayKey)}</div>
        <div className="w-tl-bar">
          <DayBar day={view.today} nowFraction={view.nowFraction} emergency={view.emergency} actual={view.actualStrip} />
        </div>
      </div>
      <div className="w-tl-row" style={{ marginTop: 8 }}>
        <div className="w-row-label">Завтра {formatDM(tomorrowKey)}</div>
        <DayBar day={view.tomorrow} emptyText="ще не опубліковано" />
      </div>
      <div className="w-tl-row">
        <div className="w-row-label" />
        <DayTicks />
      </div>
      <Caption view={view} footWarning={lineChanged} updated={updated} />
    </>
  );
}

