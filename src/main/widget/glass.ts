import type { WallpaperStyle } from './wallpaper-parse';

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Which part of the wallpaper image lies under the widget. Everything on screen is in physical px; the result is in
 * image px, clipped to the image. null: nothing of the image is under the widget (letterbox) - use the tint.
 */
export function computeCrop(
  img: { width: number; height: number }, style: WallpaperStyle, monitor: Rect, virtual: Rect, widget: Rect,
): Rect | null {
  const area = style === 'span' ? virtual : monitor;
  const rx = widget.x - area.x;
  const ry = widget.y - area.y;
  let sx: number, sy: number, ox: number, oy: number; // image px -> area px: p = i * s + o
  switch (style) {
    case 'fill': case 'span': case 'fit': {
      const a = area.width / img.width, b = area.height / img.height;
      sx = sy = style === 'fit' ? Math.min(a, b) : Math.max(a, b);
      break;
    }
    case 'stretch':
      sx = area.width / img.width; sy = area.height / img.height;
      break;
    case 'center': case 'tile':
      sx = sy = 1;
      break;
  }
  let x: number, y: number;
  if (style === 'tile') {
    x = ((rx % img.width) + img.width) % img.width;
    y = ((ry % img.height) + img.height) % img.height;
  } else {
    ox = style === 'stretch' ? 0 : (area.width - img.width * sx) / 2;
    oy = style === 'stretch' ? 0 : (area.height - img.height * sy) / 2;
    x = (rx - ox) / sx;
    y = (ry - oy) / sy;
  }
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(img.width, x + widget.width / sx), y1 = Math.min(img.height, y + widget.height / sy);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Change-detection key for the 60 s poll: differs whenever the wallpaper path, style, mtime or readability changes. */
export function wallpaperSignature(wp: { path: string; style: WallpaperStyle } | null, mtimeMs: number): string {
  return wp ? `${wp.path}|${wp.style}|${mtimeMs}` : 'none';
}
