import { addDays, formatDM } from '../../../shared/time';
import type { WidgetView } from '../../../shared/widget-state';
import { DayBar, DayTicks } from './DayBar';
import { Caption, countdownText, Status, WarnLine } from './parts';

function DayLabel({ name, dateKey }: { name: string; dateKey: string }) {
  return <div className="w-tl-label"><span className="w-tl-day">{name}</span> <span className="w-tl-date">{formatDM(dateKey)}</span></div>;
}

/**
 * Timeline (widget-timeline.html): the status and the next change with the big countdown beside them, today's and
 * tomorrow's strips, and a caption that also names the provider.
 */
export function TimelineWidget({ view, lineChanged, provider }: { view: WidgetView; lineChanged: boolean; provider: string }) {
  const tomorrowKey = view.tomorrow?.date ?? addDays(view.todayKey, 1);
  // On a mismatch nextText already carries «з HH:MM».
  const since = view.actual && !view.actual.mismatch ? view.actual.sinceText : undefined;
  const count = countdownText(view);
  // The provider name comes last in the one ellipsized label, so it gives way first.
  const label = [view.lineLabel, provider].filter(Boolean).join(' · ');
  return (
    <>
      <div className={view.outageBadge ? 'w-tl-head w-tl-badged' : 'w-tl-head'}>
        <div className="w-tl-main">
          <Status view={view} since={since} />
          <div className="w-tl-line w-ellipsis" title={view.nextText} data-capture="next">{view.nextText}</div>
        </div>
        {count && (
          <div className="w-tl-count">
            <div className="w-tl-big" data-capture="count">{count}</div>
            <div className="w-tl-cl w-ellipsis" title={view.countdownCaption} data-capture="countcap">{view.countdownCaption}</div>
          </div>
        )}
      </div>
      {lineChanged && <WarnLine />}
      <div className="w-spacer" />
      <div className="w-tl-row">
        <DayLabel name="Сьогодні" dateKey={view.todayKey} />
        <DayBar day={view.today} nowFraction={view.nowFraction} emergency={view.emergency} actual={view.actualStrip} />
      </div>
      <div className="w-tl-row w-tl-tomorrow">
        <DayLabel name="Завтра" dateKey={tomorrowKey} />
        <DayBar day={view.tomorrow} emptyText="ще не опубліковано" />
      </div>
      <DayTicks />
      <Caption view={view} label={label} updated={view.updatedText} />
    </>
  );
}
