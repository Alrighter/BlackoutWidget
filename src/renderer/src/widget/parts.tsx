import type { WidgetView } from '../../../shared/widget-state';
import { OutageBadge } from './OutageBadge';

export function Status({ view }: { view: WidgetView }) {
  return (
    <div className={`w-status${view.title.length > 14 ? ' w-long' : ''}`}>
      <span className={`w-dot ${view.state}`} />
      <span className="w-ellipsis" title={view.title}>{view.title}</span>
      {view.outageBadge && <OutageBadge text={view.outageBadge} />}
    </div>
  );
}

const WARNING = 'Схема підключення змінилась — перевірте лінію';

/**
 * Footer line, always kept inside the fixed window: the main text ellipsizes, the stale mark never shrinks.
 * The line-changed warning replaces the caption.
 */
export function Caption({ view, lineChanged, text }: { view: WidgetView; lineChanged: boolean; text?: string }) {
  if (lineChanged) return <div className="w-muted w-warn w-cap-warn" title={WARNING}>{WARNING}</div>;
  const main = text ?? (view.updatedText ? `${view.lineLabel} · ${view.updatedText}` : '');
  if (!main) return null;
  return (
    <div className="w-muted w-cap" title={view.stale ? `${main} · дані застаріли` : main}>
      <span className="w-ellipsis">{main}</span>
      {view.stale && <span className="w-warn w-stale"> · дані застаріли</span>}
    </div>
  );
}
