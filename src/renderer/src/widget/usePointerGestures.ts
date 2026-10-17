import { useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { RendererApi } from '../../../shared/ipc';

/** Movement (px) past which a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 4;

interface Press { pointerId: number; x: number; y: number; dragging: boolean }

/**
 * Left press without moving more than 4 px → open the schedule; moving further → drag the window (main moves it
 * by the screen delta from the press point); right click → widget context menu.
 */
export function usePointerGestures(api: Pick<RendererApi, 'widgetDrag' | 'openMainWindow' | 'widgetContextMenu'>) {
  const press = useRef<Press | null>(null);

  return useMemo(() => {
    const finish = (e: ReactPointerEvent<HTMLElement>, click: boolean) => {
      const p = press.current;
      if (!p || p.pointerId !== e.pointerId) return;
      press.current = null;
      const el = e.currentTarget;
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (p.dragging) api.widgetDrag('end', e.screenX, e.screenY);
      else if (click) api.openMainWindow('schedule');
    };

    return {
      onPointerDown(e: ReactPointerEvent<HTMLElement>) {
        if (e.button !== 0) return;
        press.current = { pointerId: e.pointerId, x: e.screenX, y: e.screenY, dragging: false };
        const el = e.currentTarget;
        try {
          if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
        } catch { /* pointer already gone (NotFoundError); the press still works without capture */ }
      },
      onPointerMove(e: ReactPointerEvent<HTMLElement>) {
        const p = press.current;
        if (!p || p.pointerId !== e.pointerId) return;
        if (!p.dragging) {
          if (Math.hypot(e.screenX - p.x, e.screenY - p.y) <= DRAG_THRESHOLD) return;
          p.dragging = true;
          api.widgetDrag('start', p.x, p.y);
        }
        api.widgetDrag('move', e.screenX, e.screenY);
      },
      onPointerUp(e: ReactPointerEvent<HTMLElement>) { finish(e, true); },
      /** A cancelled press still ends a drag (so the position is saved) but is never a click. */
      onPointerCancel(e: ReactPointerEvent<HTMLElement>) { finish(e, false); },
      onContextMenu(e: ReactMouseEvent<HTMLElement>) {
        e.preventDefault();
        api.widgetContextMenu();
      },
    };
  }, [api]);
}
