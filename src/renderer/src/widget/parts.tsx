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
 * Footer, always kept inside the fixed window: «оновлено HH:MM» and the stale mark never shrink, only the optional label
 * before them ellipsizes. The line-changed warning takes a line of its own above — it never hides the updated time.
 */
export function Caption({ view, lineChanged, label, updated }: {
  view: WidgetView; lineChanged: boolean; label?: string; updated: string;
}) {
  if (!updated && !lineChanged) return null;
  const title = [label, updated, view.stale ? 'дані застаріли' : ''].filter(Boolean).join(' · ');
  return (
    <div className={lineChanged ? 'w-foot w-foot-changed' : 'w-foot'}>
      {lineChanged && <div className="w-muted w-warn w-cap-warn" title={WARNING}>{WARNING}</div>}
      {updated && (
        <div className="w-muted w-cap" title={title}>
          {label && <><span className="w-ellipsis">{label}</span><span className="w-sep"> · </span></>}
          <span className="w-fixed">{updated}</span>
          {view.stale && <><span className="w-sep"> · </span><span className="w-warn w-stale">дані застаріли</span></>}
        </div>
      )}
    </div>
  );
}
