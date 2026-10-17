import type { WidgetView } from '../../../shared/widget-state';
import { ActualLine, DayBar, DayTicks } from './DayBar';
import { Caption, Status } from './parts';

export function CompactWidget({ view, lineChanged }: { view: WidgetView; lineChanged: boolean }) {
  // On a mismatch nextText already carries «з HH:MM».
  const since = view.actual && !view.actual.mismatch ? view.actual.sinceText : undefined;
  const next = since ? `${view.nextText} · ${since}` : view.nextText;
  return (
    <>
      <Status view={view} />
      <div className="w-next w-ellipsis" title={next}>{next}</div>
      <div className={lineChanged ? 'w-compact-bar w-tight' : 'w-compact-bar'}>
        <DayBar day={view.today} nowFraction={view.nowFraction} />
        {view.actualStrip?.length ? <ActualLine parts={view.actualStrip} /> : null}
        <DayTicks />
      </div>
      <Caption view={view} lineChanged={lineChanged} label={view.lineLabel} updated={view.updatedText} />
    </>
  );
}
