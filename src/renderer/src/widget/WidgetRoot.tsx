import { useEffect, useState, type SyntheticEvent } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import type { AppState, WidgetBackground } from '../../../shared/types';
import { usePointerGestures } from './usePointerGestures';
import { Widget } from './Widget';

/** `npm run dev` only: log pointer input so a pinned window's click-through can be checked from main's console. */
const logPointer = import.meta.env.MODE === 'development'
  ? (e: SyntheticEvent) => {
    const p = e.nativeEvent as MouseEvent;
    console.log(`pointer ${e.type} button=${p.button} screen=${p.screenX},${p.screenY}`);
  }
  : undefined;

/** Subscribes to main-process state and ticks the clock on minute boundaries. The root element is where gestures attach. */
export function WidgetRoot({ api }: { api: RendererApi }) {
  const [state, setState] = useState<AppState | null>(null);
  const [background, setBackground] = useState<WidgetBackground>({ kind: 'tint' });
  const [now, setNow] = useState(() => new Date());
  const [moving, setMoving] = useState(false);
  const gestures = usePointerGestures(api);

  useEffect(() => api.onMoveMode(setMoving), [api]);

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
  return (
    <div className={moving ? 'w-root w-moving' : 'w-root'} {...gestures}
      onPointerDownCapture={logPointer} onPointerUpCapture={logPointer} onContextMenuCapture={logPointer}>
      <Widget state={state} now={now} background={background} />
      {moving && (
        // Its press must not reach the root: with pointer capture there the click would land on the root instead.
        <button type="button" className="w-done" onPointerDown={e => e.stopPropagation()} onClick={() => api.endMoveMode()}>
          Готово
        </button>
      )}
    </div>
  );
}
