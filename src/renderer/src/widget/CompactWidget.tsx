import type { WidgetView } from '../../../shared/widget-state';
import { DayBar, DayTicks } from './DayBar';
import { Caption, Status } from './parts';

export function CompactWidget({ view, lineChanged }: { view: WidgetView; lineChanged: boolean }) {
  return (
    <>
      <Status view={view} />
      <div className="w-next">{view.nextText}</div>
      <div className="w-compact-bar">
        <DayBar day={view.today} nowFraction={view.nowFraction} />
        <DayTicks />
      </div>
      <Caption view={view} lineChanged={lineChanged} />
    </>
  );
}
