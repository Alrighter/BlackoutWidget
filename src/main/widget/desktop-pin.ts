import type { BrowserWindow, Rectangle } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import { MacNativeGlass, type NativeGlass } from './glass-darwin';
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

/** The widget window's native side: the desktop pinner and, on macOS, the native glass (null: the tint glass). */
export interface DesktopNative {
  pinner: DesktopPinner;
  glass: NativeGlass | null;
}

export function createDesktopNative(log: Logger, opts: DesktopPinnerOptions, env: Partial<DesktopPinnerEnv> = {}): DesktopNative {
  const platform = env.platform ?? process.platform;
  if (platform === 'darwin') return createMacNative(log, opts, env.fs ?? nodeFs, env.loadObjc ?? (() => loadObjc()));
  return { pinner: createOtherPinner(log, platform), glass: null };
}

export function createDesktopPinner(log: Logger, opts: DesktopPinnerOptions, env: Partial<DesktopPinnerEnv> = {}): DesktopPinner {
  return createDesktopNative(log, opts, env).pinner;
}

function createOtherPinner(log: Logger, platform: NodeJS.Platform): DesktopPinner {
  if (platform === 'win32') {
    try {
      return new Win32DesktopPinner();
    } catch (err) {
      // A missing native FFI binary must not take the app down; the widget then just isn't pinned.
      log.error('desktop pinning unavailable, falling back to NoopPinner (widget not pinned)', err);
      return new NoopPinner();
    }
  }
  log.warn(`no desktop pinner for platform ${platform}, using NoopPinner (widget not pinned)`);
  return new NoopPinner();
}

/**
 * A wrong FFI call kills the process instead of throwing, so the native side runs behind one crash guard, shared by
 * the pinner and the glass: if the previous run of this version died inside it, both stay off. Each fallback logs one
 * line.
 */
function createMacNative(log: Logger, opts: DesktopPinnerOptions, fs: PinGuardFs, load: () => ObjcBindings): DesktopNative {
  try {
    const marker = join(opts.userData, PIN_GUARD_FILE);
    const guard = createPinGuard(fs, marker, opts.version, log);
    if (guard.disabled) {
      log.warn(`macOS native window calls crashed Blackout Widget ${opts.version} before; using NoopPinner (widget not ` +
        `pinned) and the tint glass. Delete ${marker} to try again`);
      return { pinner: new NoopPinner(), glass: null };
    }
    // Loading runs under the guard too: a native crash loading koffi or the dylibs must not become a crash loop.
    const objc = guard.run(load);
    return { pinner: new MacDesktopPinner(objc, guard, log), glass: new MacNativeGlass(objc, guard, log) };
  } catch (err) {
    log.error('macOS desktop pinning and native glass unavailable, falling back to NoopPinner (widget not pinned) ' +
      'and the tint glass', err);
    return { pinner: new NoopPinner(), glass: null };
  }
}
