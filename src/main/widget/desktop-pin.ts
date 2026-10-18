import type { BrowserWindow, Rectangle } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import { loadObjc, type ObjcBindings } from './objc-darwin';
import { MacDesktopPinner } from './pin-darwin';
import { createPinGuard, PIN_GUARD_FILE, type PinGuardFs } from './pin-guard';
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
export class NoopPinner implements DesktopPinner {
  readonly pinned = false;
  pin(): void {}
  unpin(): void {}
  setBounds(win: BrowserWindow, rect: Rectangle): void {
    if (!win.isDestroyed()) win.setBounds(rect);
  }
  dispose(): void {}
}

export interface DesktopPinnerOptions {
  /** Electron's userData directory: the macOS crash guard keeps its marker there. */
  userData: string;
  /** The app version: a crash while pinning turns macOS pinning off for this version only. */
  version: string;
}

/** Test seams; the defaults are the real platform, fs and Objective-C runtime. */
export interface DesktopPinnerEnv {
  platform: NodeJS.Platform;
  fs: PinGuardFs;
  loadObjc: () => ObjcBindings;
}

const nodeFs: PinGuardFs = { existsSync, readFileSync, rmSync, writeFileSync };

export function createDesktopPinner(log: Logger, opts: DesktopPinnerOptions, env: Partial<DesktopPinnerEnv> = {}): DesktopPinner {
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') {
    try {
      return new Win32DesktopPinner();
    } catch (err) {
      // A missing native FFI binary must not take the app down; the widget then just isn't pinned.
      log.error('desktop pinning unavailable, falling back to NoopPinner (widget not pinned)', err);
      return new NoopPinner();
    }
  }
  if (platform === 'darwin') return createMacPinner(log, opts, env.fs ?? nodeFs, env.loadObjc ?? (() => loadObjc()));
  log.warn(`no desktop pinner for platform ${platform}, using NoopPinner (widget not pinned)`);
  return new NoopPinner();
}

/**
 * A wrong FFI call kills the process instead of throwing, so the native side runs behind a crash guard: if the
 * previous run of this version died inside it, pinning stays off. Each fallback logs one line.
 */
function createMacPinner(log: Logger, opts: DesktopPinnerOptions, fs: PinGuardFs, load: () => ObjcBindings): DesktopPinner {
  const marker = join(opts.userData, PIN_GUARD_FILE);
  try {
    const guard = createPinGuard(fs, marker, opts.version);
    if (guard.disabled) {
      log.warn(`macOS desktop pinning crashed Blackout Widget ${opts.version} before; using NoopPinner (widget not pinned). ` +
        `Delete ${marker} to try again`);
      return new NoopPinner();
    }
    // Loading runs under the guard too: a native crash loading koffi or the dylibs must not become a crash loop.
    return new MacDesktopPinner(guard.run(load), guard, log);
  } catch (err) {
    log.error('macOS desktop pinning unavailable, falling back to NoopPinner (widget not pinned)', err);
    return new NoopPinner();
  }
}
