import type { BrowserWindow, Rectangle } from 'electron';
import { silentLogger, type Logger } from '../log';
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

export function createDesktopPinner(log: Logger = silentLogger): DesktopPinner {
  if (process.platform === 'win32') {
    try {
      return new Win32DesktopPinner();
    } catch (err) {
      // A missing native FFI binary must not take the app down; the widget then just isn't pinned.
      log.error('desktop pinning unavailable, falling back to NoopPinner (widget not pinned)', err);
      return new NoopPinner();
    }
  }
  log.warn(`no desktop pinner for platform ${process.platform}, using NoopPinner (widget not pinned)`);
  return new NoopPinner();
}
