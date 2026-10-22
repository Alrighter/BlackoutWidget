import type { BrowserWindow, Rectangle } from 'electron';
import { silentLogger, type Logger } from '../log';
import type { DesktopPinner } from './desktop-pin';
import type { ObjcBindings, ObjcPtr } from './objc-darwin';
import type { PinGuard } from './pin-guard';

/** CoreGraphics/CGWindowLevel.h: kCGDesktopIconWindowLevelKey, the level of the Finder's desktop icons. */
export const kCGDesktopIconWindowLevelKey = 18;
/**
 * How far above the desktop icons the widget sits. The one knob to turn if the pinned widget gets no mouse input
 * on some macOS (spec §7.3: the tray then keeps every control).
 */
export const PIN_LEVEL_OFFSET = 1;
/** AppKit/NSWindow.h: NSNormalWindowLevel (= kCGNormalWindowLevel). */
export const NSNormalWindowLevel = 0;
/** AppKit/NSWindow.h, NSWindowCollectionBehavior: on every Space. */
export const NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0;
/** AppKit/NSWindow.h: unaffected by Mission Control and «Show Desktop», like the desktop itself. */
export const NSWindowCollectionBehaviorStationary = 1 << 4;
/** AppKit/NSWindow.h: left out of Cmd+` window cycling. */
export const NSWindowCollectionBehaviorIgnoresCycle = 1 << 6;
export const PIN_COLLECTION_BEHAVIOR =
  NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
/**
 * How long the crash marker stays after a good pin (and after the native glass's corner calls): AppKit acts on a new
 * level in the run-loop cycles after setLevel:, so a crash there still turns native calls off. App quit ends it early.
 */
export const PIN_HOLD_MS = 10_000;

/**
 * macOS: the widget stays an ordinary frameless window, but its NSWindow goes just above the desktop icons (under
 * every normal window), on every Space and stationary in Mission Control / «Show Desktop» (spec §7.2). Every native
 * call runs inside the crash guard; a JS-level failure is logged and leaves the widget an ordinary window. Nothing may
 * call Electron's setAlwaysOnTop / setVisibleOnAllWorkspaces while pinned: they rewrite the level or the behaviour.
 */
export class MacDesktopPinner implements DesktopPinner {
  private isPinned = false;
  private readonly sel: { window: ObjcPtr; setLevel: ObjcPtr; setCollectionBehavior: ObjcPtr; setCanHide: ObjcPtr };

  constructor(private readonly objc: ObjcBindings, private readonly guard: PinGuard, private readonly log: Logger = silentLogger) {
    // sel_registerName is native too: every selector is registered once, here, under the guard.
    this.sel = guard.run(() => ({
      window: objc.sel('window'), setLevel: objc.sel('setLevel:'), setCollectionBehavior: objc.sel('setCollectionBehavior:'),
      setCanHide: objc.sel('setCanHide:'),
    }));
  }

  /** Whether the last pin succeeded (and no unpin came after it). */
  get pinned(): boolean { return this.isPinned; }

  pin(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.isPinned = false;
    try {
      this.guard.run(() => {
        const level = this.objc.windowLevelForKey(kCGDesktopIconWindowLevelKey) + PIN_LEVEL_OFFSET;
        this.apply(win, level, PIN_COLLECTION_BEHAVIOR);
      }, { holdMs: PIN_HOLD_MS });
      this.isPinned = true;
    } catch (err) {
      this.log.error('pinning the widget to the macOS desktop failed; it stays an ordinary window', err);
    }
  }

  /** For the §7.3 move mode: back to a normal-level window, still on every Space. */
  unpin(win: BrowserWindow): void {
    this.isPinned = false;
    if (win.isDestroyed()) return;
    try {
      this.guard.run(() => this.apply(win, NSNormalWindowLevel, NSWindowCollectionBehaviorCanJoinAllSpaces));
    } catch (err) {
      this.log.error('unpinning the widget from the macOS desktop failed', err);
    }
  }

  setBounds(win: BrowserWindow, rect: Rectangle): void {
    if (!win.isDestroyed()) win.setBounds(rect);
  }

  /**
   * Its widget is gone (location deleted, or app quit). Nothing native to undo, and the crash marker stays: it is shared
   * with the other widgets' pins, and DesktopNative.release() drops it once, at quit.
   */
  dispose(): void {
    this.isPinned = false;
  }

  private apply(win: BrowserWindow, level: number, behavior: number): void {
    const view: ObjcPtr = win.getNativeWindowHandle().readBigUInt64LE(0); // NSView* on macOS
    const nswin = this.objc.msgId(view, this.sel.window); // -[NSView window]
    // Messaging nil does nothing and returns 0: without this check a failed lookup would look like a pin.
    if (!nswin) throw new Error('the widget NSView has no NSWindow');
    this.objc.msgVoidLong(nswin, this.sel.setLevel, level); // -[NSWindow setLevel:(NSWindowLevel = NSInteger)]
    this.objc.msgVoidULong(nswin, this.sel.setCollectionBehavior, behavior); // NSWindowCollectionBehavior = NSUInteger
    // -[NSWindow setCanHide:(BOOL)] NO: Cmd+H (Hide Blackout Widget) must not take the widget off the desktop. Electron
    // never sets it here (app.dock.hide() runs before the widget exists). Sent by unpin too: move mode needs no hiding,
    // so it stays NO and is never restored.
    this.objc.msgVoidBool(nswin, this.sel.setCanHide, false);
  }
}
