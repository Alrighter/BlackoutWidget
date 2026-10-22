import { useEffect, useState, type SyntheticEvent } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import type { WidgetBackground, WidgetState } from '../../../shared/types';
import { usePointerGestures } from './usePointerGestures';
import { Widget } from './Widget';

/** `npm run dev` only: log pointer input so a pinned window's click-through can be checked from main's console. */
const logPointer = import.meta.env.MODE === 'development'
  ? (e: SyntheticEvent) => {
    const p = e.nativeEvent as MouseEvent;
    console.log(`pointer ${e.type} button=${p.button} screen=${p.screenX},${p.screenY}`);
  }
  : undefined;

/**
 * Move mode (D6, tray-menu.html): the mockup's dashed double frame, move glyph and «Перетягніть…» pill. The window keeps
 * its size, so they lie inside the card, over the content. A press on the pill drags the widget like one on the card.
 */
function MoveOverlay({ onDone }: { onDone(): void }) {
  return (
    <div className="w-move">
      <div className="w-move-frame" aria-hidden="true" />
      <span className="w-move-glyph" aria-hidden="true" data-capture="move-glyph">
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
        </svg>
      </span>
      <div className="w-move-pill" data-capture="move-pill">
        <span className="w-move-hint" data-capture="move-hint">Перетягніть віджет у потрібне місце</span>
        {/* Its press must not reach the root: with pointer capture there the click would land on the root instead. */}
        <button type="button" className="w-done" data-capture="move-done" onPointerDown={e => e.stopPropagation()} onClick={onDone}>
          Готово
        </button>
      </div>
    </div>
  );
}

/** Subscribes to main-process state and ticks the clock on minute boundaries. The root element is where gestures attach. */
export function WidgetRoot({ api }: { api: RendererApi }) {
  const [state, setState] = useState<WidgetState | null>(null);
  const [background, setBackground] = useState<WidgetBackground>({ kind: 'tint' });
  const [now, setNow] = useState(() => new Date());
  const [moving, setMoving] = useState(false);
  const gestures = usePointerGestures(api);

  useEffect(() => api.onMoveMode(setMoving), [api]);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pushed = false;
    const load = () => {
      api.getWidgetState().then(
        // A pushed state is always newer than the initial fetch, so never overwrite it. Null: main doesn't know this
        // window yet (a reconcile in flight), so try again rather than show anything.
        s => {
          if (!alive) return;
          if (s) setState(prev => prev ?? s); else if (!pushed) retry = setTimeout(load, 2000);
        },
        (e: unknown) => { console.error('widget getWidgetState failed', e); if (alive) retry = setTimeout(load, 2000); },
      );
    };
    load();
    // A push is fresh data: re-read the clock with it, rather than keep a `now` up to a minute old.
    const offState = api.onWidgetState(s => { pushed = true; setState(s); setNow(new Date()); });
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
      <Widget state={state} now={now} background={background}>
        {moving && <MoveOverlay onDone={() => api.endMoveMode()} />}
      </Widget>
    </div>
  );
}
