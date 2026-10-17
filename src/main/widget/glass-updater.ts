import { nativeImage, screen } from 'electron';
import { statSync } from 'node:fs';
import { IPC } from '../../shared/ipc';
import type { WidgetBackground } from '../../shared/types';
import { computeCrop, type Rect } from './glass';
import type { WidgetWindow } from './widget-window';
import { readWallpaper } from './wallpaper-win32';

const TINT: WidgetBackground = { kind: 'tint' };

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function union(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.width)), y1 = Math.max(...rects.map(r => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Keeps the widget's background layer showing the wallpaper region under it. Returns a disposer. */
export function startGlassUpdater(widget: WidgetWindow): () => void {
  let running = false;
  let again = false;
  let seen = '';

  const update = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        widget.send(IPC.background, await compute());
      } while (again);
    } finally {
      running = false;
    }
  };

  const compute = async (): Promise<WidgetBackground> => {
    try {
      const wp = await readWallpaper();
      if (!wp) return TINT;
      seen = signature(wp.path, wp.style);
      const image = nativeImage.createFromPath(wp.path);
      if (image.isEmpty()) return TINT;
      const dip = widget.getBoundsDip();
      const toPhysical = (r: Rect) => screen.dipToScreenRect(null, r);
      const monitor = toPhysical(screen.getDisplayMatching(dip).bounds);
      const virtual = union(screen.getAllDisplays().map(d => toPhysical(d.bounds)));
      const widgetPx = toPhysical(dip);
      const crop = computeCrop(image.getSize(), wp.style, monitor, virtual, widgetPx);
      if (!crop) return TINT;
      const x = Math.round(crop.x), y = Math.round(crop.y);
      const rounded = {
        x, y,
        width: Math.max(1, Math.min(image.getSize().width - x, Math.round(crop.width))),
        height: Math.max(1, Math.min(image.getSize().height - y, Math.round(crop.height))),
      };
      const small = image.crop(rounded).resize({ width: Math.max(1, Math.round(widgetPx.width / 2)) });
      return { kind: 'image', dataUrl: small.toDataURL() };
    } catch (err) {
      console.error('glass update failed', err);
      return TINT;
    }
  };

  const signature = (path: string, style: string) => `${path}|${style}|${mtimeOf(path)}`;
  const trigger = () => { void update(); };

  // Cheap poll: re-crop only when the wallpaper path, style or file mtime changed.
  const poll = setInterval(() => {
    readWallpaper()
      .then(wp => { if (wp && signature(wp.path, wp.style) !== seen) trigger(); })
      .catch(() => {});
  }, 60_000);

  widget.onMoved(trigger);
  screen.on('display-metrics-changed', trigger);
  screen.on('display-added', trigger);
  screen.on('display-removed', trigger);
  trigger();

  return () => {
    clearInterval(poll);
    screen.off('display-metrics-changed', trigger);
    screen.off('display-added', trigger);
    screen.off('display-removed', trigger);
  };
}
