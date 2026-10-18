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
 * macOS: the widget stays an ordinary frameless window, but its NSWindow goes just above the desktop icons (under
 * every normal window), on every Space and stationary in Mission Control / «Show Desktop» (spec §7.2). Every native
 * call runs inside the crash guard; a JS-level failure is logged and leaves the widget an ordinary window.
 */
export class MacDesktopPinner implements DesktopPinner {
  private isPinned = false;

  constructor(private readonly objc: ObjcBindings, private readonly guard: PinGuard, private readonly log: Logger = silentLogger) {}

  /** Whether the last pin succeeded (and no unpin came after it). */
  get pinned(): boolean { return this.isPinned; }

  pin(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.isPinned = false;
    try {
      this.guard.run(() => {
        const level = this.objc.windowLevelForKey(kCGDesktopIconWindowLevelKey) + PIN_LEVEL_OFFSET;
        this.apply(win, level, PIN_COLLECTION_BEHAVIOR);
      });
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

  dispose(): void {}

  private apply(win: BrowserWindow, level: number, behavior: number): void {
    const view: ObjcPtr = win.getNativeWindowHandle().readBigUInt64LE(0); // NSView* on macOS
    const nswin = this.objc.msgId(view, this.objc.sel('window')); // -[NSView window]
    // Messaging nil does nothing and returns 0: without this check a failed lookup would look like a pin.
    if (!nswin) throw new Error('the widget NSView has no NSWindow');
    this.objc.msgVoidLong(nswin, this.objc.sel('setLevel:'), level); // -[NSWindow setLevel:(NSWindowLevel = NSInteger)]
    this.objc.msgVoidULong(nswin, this.objc.sel('setCollectionBehavior:'), behavior); // NSWindowCollectionBehavior = NSUInteger
  }
}
