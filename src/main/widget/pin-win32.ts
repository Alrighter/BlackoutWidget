import { screen, type BrowserWindow, type Rectangle } from 'electron';
import type { DesktopPinner } from './desktop-pin';

const WM_SPAWN_WORKER = 0x052c; // undocumented: makes Progman create the WorkerW wallpaper layer
const SMTO_NORMAL = 0;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
// No WM_WINDOWPOSCHANGING: a non-resizable Electron window clamps size changes that don't come from its own
// setBounds back to the old size there (min = max = size), so a pinned style change would not resize.
const SWP_NOSENDCHANGING = 0x0400;
const GA_PARENT = 1;
const WATCH_MS = 5000;

interface RECT { left: number; top: number; right: number; bottom: number }

/** HWNDs cross the FFI as uintptr; koffi hands back number or bigint, so compare them as bigint only. */
type Hwnd = bigint;
const hwnd = (v: unknown): Hwnd => BigInt(v as number | bigint);
const hwndOf = (win: BrowserWindow): Hwnd => win.getNativeWindowHandle().readBigUInt64LE(0);

type User32 = ReturnType<typeof bindUser32>;
let user32: User32 | null = null;

/**
 * Bound once for the whole process: every widget has its own pinner, and koffi rejects a second struct of the
 * same name. A failed load is not kept, so the next pinner tries again (and falls back to NoopPinner on its own).
 */
function loadUser32(): User32 {
  user32 ??= bindUser32();
  return user32;
}

function bindUser32() {
  // Loaded lazily so the native binary is only touched on Windows, when a pinner is actually created.
  const koffi = require('koffi') as typeof import('koffi');
  const lib = koffi.load('user32.dll');
  koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  return {
    FindWindowW: lib.func('uintptr __stdcall FindWindowW(str16 cls, str16 name)') as (cls: string, name: string | null) => unknown,
    SendMessageTimeoutW: lib.func(
      'intptr __stdcall SendMessageTimeoutW(uintptr hwnd, uint msg, uintptr wp, intptr lp, uint flags, uint timeout, _Out_ uintptr* res)',
    ) as (h: Hwnd, msg: number, wp: number, lp: number, flags: number, timeout: number, res: unknown[]) => unknown,
    SetParent: lib.func('uintptr __stdcall SetParent(uintptr child, uintptr parent)') as (child: Hwnd, parent: Hwnd) => unknown,
    GetAncestor: lib.func('uintptr __stdcall GetAncestor(uintptr hwnd, uint flags)') as (h: Hwnd, flags: number) => unknown,
    GetWindowRect: lib.func('bool __stdcall GetWindowRect(uintptr hwnd, _Out_ RECT* rect)') as (h: Hwnd, out: Partial<RECT>) => boolean,
    SetWindowPos: lib.func('bool __stdcall SetWindowPos(uintptr hwnd, uintptr after, int x, int y, int cx, int cy, uint flags)') as
      (h: Hwnd, after: Hwnd, x: number, y: number, cx: number, cy: number, flags: number) => boolean,
  };
}

/**
 * Windows: the widget becomes a child of Progman (the desktop window), so it stays visible after Win+D and sits
 * under every normal window. Child coordinates are physical pixels relative to Progman's top-left corner.
 */
export class Win32DesktopPinner implements DesktopPinner {
  private readonly u = loadUser32();
  private readonly timer: ReturnType<typeof setInterval>;
  private win: BrowserWindow | null = null;
  /** Progman the window is attached to; 0n while not attached (unpinned, or explorer not running). */
  private progman: Hwnd = 0n;
  private rect: Rectangle | null = null;
  private wantPinned = false;

  constructor() {
    // explorer.exe restarts recreate Progman; re-attach when the window is no longer under the current one.
    this.timer = setInterval(() => this.watch(), WATCH_MS);
  }

  get pinned(): boolean { return this.wantPinned; }

  pin(win: BrowserWindow): void {
    this.win = win;
    this.wantPinned = true;
    this.attach(win);
  }

  unpin(win: BrowserWindow): void {
    this.wantPinned = false;
    this.progman = 0n;
    if (win.isDestroyed()) return;
    this.u.SetParent(hwndOf(win), 0n);
    if (this.rect) win.setBounds(this.rect);
  }

  setBounds(win: BrowserWindow, rect: Rectangle): void {
    this.rect = { ...rect };
    if (win.isDestroyed()) return;
    // A window that is not (yet) attached — e.g. one rebuilt after explorer took the old one down — is top-level.
    if (this.progman && win === this.win) this.place(win, rect);
    else win.setBounds(rect);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private attach(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const rect = this.rect ?? win.getBounds(); // still top-level here, so Electron's bounds are right
    const progman = hwnd(this.u.FindWindowW('Progman', null));
    if (!progman) { this.progman = 0n; return; } // explorer is (re)starting; watch() retries
    this.u.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0xd, 0x1, SMTO_NORMAL, 1000, [0]);
    this.u.SetParent(hwndOf(win), progman);
    this.progman = progman;
    this.place(win, rect);
  }

  private place(win: BrowserWindow, rect: Rectangle): void {
    const r = screen.dipToScreenRect(null, rect);
    const origin: Partial<RECT> = {};
    this.u.GetWindowRect(this.progman, origin);
    this.u.SetWindowPos(hwndOf(win), 0n, r.x - (origin.left ?? 0), r.y - (origin.top ?? 0), r.width, r.height,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
  }

  private watch(): void {
    const win = this.win;
    if (!this.wantPinned || !win || win.isDestroyed()) return;
    const current = hwnd(this.u.FindWindowW('Progman', null));
    if (!current) return; // explorer not back yet
    // GetAncestor, not GetParent: the window keeps its non-WS_CHILD style, and for such windows GetParent returns
    // the owner (none), never Progman — checking it would re-pin every 5 s.
    if (current === this.progman && hwnd(this.u.GetAncestor(hwndOf(win), GA_PARENT)) === current) return;
    console.warn('widget lost its desktop parent (explorer restart?); pinning again');
    this.attach(win);
  }
}
