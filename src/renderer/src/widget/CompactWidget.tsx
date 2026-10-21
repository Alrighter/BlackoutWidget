import type { WidgetView } from '../../../shared/widget-state';
import { DayBar, DayTicks } from './DayBar';
import { Caption, captionLabel, Status, WarnLine } from './parts';

export function CompactWidget({ view, lineChanged, name }: { view: WidgetView; lineChanged: boolean; name: string }) {
  // On a mismatch nextText already carries «з HH:MM».
  const since = view.actual && !view.actual.mismatch ? view.actual.sinceText : undefined;
  return (
    <>
      <Status view={view} since={since} />
      <div className="w-next w-ellipsis" title={view.nextText} data-capture="next">{view.nextText}</div>
      {lineChanged && <WarnLine />}
      <div className="w-spacer" />
      <DayBar day={view.today} nowFraction={view.nowFraction} emergency={view.emergency} actual={view.actualStrip} />
      <DayTicks />
      <Caption view={view} label={captionLabel(name, view.lineLabel)} updated={view.updatedText} />
    </>
  );
}
