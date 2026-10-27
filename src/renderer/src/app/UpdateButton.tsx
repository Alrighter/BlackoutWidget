import type { RendererApi } from '../../../shared/ipc';
import type { UpdateStatus } from '../../../shared/types';
import { updateTooltip } from '../../../shared/update-text';

/** The progress ring's circumference: r = 10 in the 24-unit view box. */
const RING = 2 * Math.PI * 10;

/**
 * The header's app-update button, next to «Оновити зараз» and in its style: a down arrow while an update is offered,
 * a ring filling with the download, a red dot after a failure (a click tries again). Main does the work; the button
 * only asks for it.
 */
export function UpdateButton({ status, api }: { status: UpdateStatus | undefined; api: RendererApi }) {
  const label = updateTooltip(status);
  if (!status || !label) return null;
  const busy = status.phase === 'downloading' || status.phase === 'installing';
  return (
    <button className="app-refresh app-update" aria-label={label} title={label} data-capture="update" disabled={busy}
      onClick={() => { api.installUpdate().catch(() => {}); }}>
      {busy ? (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="app-update-track" cx="12" cy="12" r="10" />
          <circle className="app-update-ring" cx="12" cy="12" r="10" transform="rotate(-90 12 12)"
            strokeDasharray={`${(RING * (status.phase === 'downloading' ? status.percent : 100)) / 100} ${RING}`} />
          <path d="M12 7.5v8" /><path d="m8.5 12.5 3.5 3.5 3.5-3.5" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
      )}
      {status.phase === 'error' && <span className="app-update-dot" aria-hidden="true" />}
    </button>
  );
}
