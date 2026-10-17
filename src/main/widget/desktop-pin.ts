import type { BrowserWindow, Rectangle } from 'electron';
import { Win32DesktopPinner } from './pin-win32';

/** Keeps the widget window on the desktop layer: under normal windows, visible after "show desktop". */
export interface DesktopPinner {
  pin(win: BrowserWindow): void;
  unpin(win: BrowserWindow): void;
  /** Moves/resizes the window (DIP), whether pinned or not. */
  setBounds(win: BrowserWindow, rect: Rectangle): void;
  readonly pinned: boolean;
  dispose(): void;
}

/** Platforms without a desktop pinner yet: the widget is an ordinary frameless window. */
class NoopPinner implements DesktopPinner {
  readonly pinned = false;
  pin(): void {}
  unpin(): void {}
  setBounds(win: BrowserWindow, rect: Rectangle): void {
    if (!win.isDestroyed()) win.setBounds(rect);
  }
  dispose(): void {}
}

export function createDesktopPinner(): DesktopPinner {
  if (process.platform === 'win32') {
    try {
      return new Win32DesktopPinner();
    } catch (err) {
      // A missing native FFI binary must not take the app down; the widget then just isn't pinned.
      console.error('desktop pinning unavailable', err);
    }
  }
  return new NoopPinner();
}
