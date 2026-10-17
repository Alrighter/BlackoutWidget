import { useEffect, useState } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import type { AppState, WidgetBackground } from '../../../shared/types';
import { Widget } from './Widget';

/** Subscribes to main-process state and ticks the clock on minute boundaries. The root element is where gestures attach. */
export function WidgetRoot({ api }: { api: RendererApi }) {
  const [state, setState] = useState<AppState | null>(null);
  const [background, setBackground] = useState<WidgetBackground>({ kind: 'tint' });
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.getState().then(
        // A pushed state is always newer than the initial fetch, so never overwrite it.
        s => { if (alive) setState(prev => prev ?? s); },
        (e: unknown) => { console.error('widget getState failed', e); if (alive) retry = setTimeout(load, 2000); },
      );
    };
    load();
    const offState = api.onState(setState);
    const offBg = api.onBackground(setBackground);
    return () => { alive = false; clearTimeout(retry); offState(); offBg(); };
  }, [api]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => { setNow(new Date()); schedule(); }, 60_000 - (Date.now() % 60_000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  if (!state) return null;
  return <div className="w-root"><Widget state={state} now={now} background={background} /></div>;
}
