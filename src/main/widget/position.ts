import type { WidgetPosition } from '../../shared/types';

export interface DisplayLike { id: number; workArea: { x: number; y: number; width: number; height: number } }
export interface Rect { x: number; y: number; width: number; height: number }
type Size = { width: number; height: number };

/** The least distance (DIP) between two widgets that findFreeSpot places. */
export const GAP = 16;
const MARGIN = 24;
const STEP = 16;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

/** Strict on both axes: rects that only touch do not intersect, so a spot exactly GAP away counts as free. */
const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/**
 * Scan positions on one axis, in scan order: the STEP grid from `from` to `to` in direction `dir`, plus every
 * `edges` value in that range; none when the range is empty (an area too small for the widget). The grid alone
 * could leave a wider gap than GAP (a widget 24 + 150 + 16 down is off the grid from 24), and the first free spot
 * along an axis is always the start or right past a neighbour, so the edges keep a neighbour exactly GAP away.
 */
function axis(from: number, to: number, dir: 1 | -1, edges: number[]): number[] {
  const inRange = (v: number) => (dir > 0 ? v >= from && v <= to : v <= from && v >= to);
  const out = new Set<number>();
  for (let v = from; inRange(v); v += dir * STEP) out.add(v);
  for (const e of edges) if (inRange(e)) out.add(e);
  return [...out].sort((a, b) => dir * (a - b));
}

/**
 * The first spot in `area` where a widget of `size` keeps at least GAP from every rect in `others`. The scan
 * starts at the default corner (top-right, MARGIN in), goes down first, then one column to the left; null when
 * there is no such spot.
 */
export function findFreeSpot(area: Rect, size: Size, others: Rect[]): { x: number; y: number } | null {
  const blocked = others.map(o => inflate(o, GAP));
  const xs = axis(area.x + area.width - size.width - MARGIN, area.x + MARGIN, -1, blocked.map(b => b.x - size.width));
  const ys = axis(area.y + MARGIN, area.y + area.height - size.height - MARGIN, 1, blocked.map(b => b.y + b.height));
  for (const x of xs) {
    for (const y of ys) {
      const rect = { x, y, ...size };
      if (!blocked.some(b => intersects(rect, b))) return { x, y };
    }
  }
  return null;
}

const corner = (d: DisplayLike, size: Size): WidgetPosition =>
  ({ x: d.workArea.x + d.workArea.width - size.width - MARGIN, y: d.workArea.y + MARGIN, displayId: d.id });

/** A free spot on `d`, else its corner: overlap is accepted only when the work area is full. */
function spotOn(d: DisplayLike, size: Size, others: Rect[]): WidgetPosition {
  const spot = findFreeSpot(d.workArea, size, others);
  return spot ? { ...spot, displayId: d.id } : corner(d, size);
}

const primaryOf = (displays: DisplayLike[], primaryId: number) => displays.find(d => d.id === primaryId) ?? displays[0];

/**
 * Where a widget goes (DIP). A saved position on a live display is pulled fully inside that display's work area,
 * neighbours or not (moving it is up to the user). No saved position, or its display is gone → the first free
 * spot on the primary display, clear of `others` (the other widgets), else its top-right corner. The caller does
 * not save that spot, so the widget returns once its display does.
 */
export function placeWidget(
  pos: WidgetPosition | null, size: Size, displays: DisplayLike[], primaryId: number, others: Rect[] = [],
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
  return spotOn(primaryOf(displays, primaryId), size, others);
}

/** A new location's widget: the first free spot on the anchor display (the first location's), else on the primary. */
export function placeNewWidget(
  size: Size, displays: DisplayLike[], primaryId: number, anchorDisplayId: number | undefined, others: Rect[],
): WidgetPosition {
  const anchor = anchorDisplayId === undefined ? undefined : displays.find(d => d.id === anchorDisplayId);
  return spotOn(anchor ?? primaryOf(displays, primaryId), size, others);
}
