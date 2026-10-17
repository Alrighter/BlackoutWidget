import type { WidgetView } from '../../../shared/widget-state';
import { OutageBadge } from './OutageBadge';

export function Status({ view }: { view: WidgetView }) {
  return (
    <div className="w-status">
      <span className={`w-dot ${view.state}`} />
      <span>{view.title}</span>
      {view.outageBadge && <OutageBadge text={view.outageBadge} />}
    </div>
  );
}

export function StaleMark() {
  return <span className="w-warn"> · дані застаріли</span>;
}

/** Footer line: the line-changed warning replaces the caption. */
export function Caption({ view, lineChanged, text }: { view: WidgetView; lineChanged: boolean; text?: string }) {
  if (lineChanged) return <div className="w-muted w-warn">Схема підключення змінилась — перевірте лінію</div>;
  return <div className="w-muted">{text ?? `${view.lineLabel} · ${view.updatedText}`}{view.stale && <StaleMark />}</div>;
}
