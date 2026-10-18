import type { WidgetPosition } from '../../shared/types';

export interface DisplayLike { id: number; workArea: { x: number; y: number; width: number; height: number } }

const MARGIN = 24;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

/**
 * Where the widget goes (DIP). No saved position, or its display is gone → top-right corner of the primary
 * display's work area; otherwise the saved position pulled fully inside its own display's work area.
 */
export function placeWidget(
  pos: WidgetPosition | null, size: { width: number; height: number }, displays: DisplayLike[], primaryId: number,
): WidgetPosition {
  const own = pos ? displays.find(d => d.id === pos.displayId) : undefined;
  if (pos && own) {
    const a = own.workArea;
    return {
      x: clamp(Math.round(pos.x), a.x, a.x + a.width - size.width),
      y: clamp(Math.round(pos.y), a.y, a.y + a.height - size.height),
      displayId: own.id,
    };
  }
  const primary = displays.find(d => d.id === primaryId) ?? displays[0];
  const a = primary.workArea;
  return { x: a.x + a.width - size.width - MARGIN, y: a.y + MARGIN, displayId: primary.id };
}
