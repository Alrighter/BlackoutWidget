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
    void api.getState().then(s => { if (alive) setState(s); });
    const offState = api.onState(setState);
    const offBg = api.onBackground(setBackground);
    return () => { alive = false; offState(); offBg(); };
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
