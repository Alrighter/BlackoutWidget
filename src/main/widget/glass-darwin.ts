import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WidgetStyle } from '../../shared/types';
import { WIDGET_RADII } from '../../shared/widget-sizes';
import { silentLogger, type Logger } from '../log';
import type { ObjcBindings, ObjcPtr } from './objc-darwin';
import { PIN_HOLD_MS } from './pin-darwin';
import type { PinGuard } from './pin-guard';

/**
 * NSVisualEffectMaterial of the widget's native glass. Popover: a small surface over the desktop with behind-window
 * blending, as Apple's popovers use it, and a semantic material that follows the system appearance (light in light,
 * dark in dark). HUD would read dark in light mode too («a HUD might not match the current appearance setting»,
 * Apple HIG, Panels). The renderer lays the mockup's own glass tint and edge over it (the `native` background kind).
 * The one knob to turn if the glass looks wrong on the Mac.
 */
export const NATIVE_VIBRANCY = 'popover' satisfies BrowserWindowConstructorOptions['vibrancy'];

export type NativeGlassWindowOptions = Pick<BrowserWindowConstructorOptions, 'vibrancy' | 'visualEffectState'>;

/** The widget window's native glass (macOS): vibrancy behind the page, its corners rounded to the card's. */
export interface NativeGlass {
  /** False once rounding failed: the widget keeps the tint glass from then on. */
  readonly enabled: boolean;
  /** Added to the widget's BrowserWindow options (which stay `transparent: true`); {} once disabled. */
  windowOptions(): NativeGlassWindowOptions;
  /**
   * Rounds `win`'s content view, and with it the vibrancy view and the page, to the card radius of `style`. False when
   * that failed (after one log line; the glass is then disabled) or the window is gone.
   */
  round(win: BrowserWindow, style: WidgetStyle): boolean;
}

/**
 * The vibrancy view Electron adds fills the whole window, square at the widget's size (Electron masks it at 9 pt at
 * most), so the content view's layer is rounded to the card and clips it: `[[nswin contentView] setWantsLayer:YES]`,
 * then on its layer `setCornerRadius:` and `setMasksToBounds:YES`. Every native call runs inside the crash guard
 * shared with MacDesktopPinner.
 */
export class MacNativeGlass implements NativeGlass {
  private on = true;
  private readonly sel: {
    window: ObjcPtr; contentView: ObjcPtr; setWantsLayer: ObjcPtr; layer: ObjcPtr; setCornerRadius: ObjcPtr; setMasksToBounds: ObjcPtr;
  };

  constructor(private readonly objc: ObjcBindings, private readonly guard: PinGuard, private readonly log: Logger = silentLogger) {
    // sel_registerName is native too: every selector is registered once, here, under the guard.
    this.sel = guard.run(() => ({
      window: objc.sel('window'),
      contentView: objc.sel('contentView'),
      setWantsLayer: objc.sel('setWantsLayer:'),
      layer: objc.sel('layer'),
      setCornerRadius: objc.sel('setCornerRadius:'),
      setMasksToBounds: objc.sel('setMasksToBounds:'),
    }));
  }

  get enabled(): boolean { return this.on; }

  windowOptions(): NativeGlassWindowOptions {
    // 'active': the widget window is never key, and an inactive material turns flat grey.
    return this.on ? { vibrancy: NATIVE_VIBRANCY, visualEffectState: 'active' } : {};
  }

  round(win: BrowserWindow, style: WidgetStyle): boolean {
    if (!this.on || win.isDestroyed()) return false;
    try {
      this.guard.run(() => this.apply(win, WIDGET_RADII[style]), { holdMs: PIN_HOLD_MS });
      return true;
    } catch (err) {
      this.on = false;
      this.log.error('rounding the macOS native glass failed; the widget keeps the tint glass', err);
      return false;
    }
  }

  private apply(win: BrowserWindow, radius: number): void {
    const { objc, sel } = this;
    const view: ObjcPtr = win.getNativeWindowHandle().readBigUInt64LE(0); // NSView* on macOS
    // Messaging nil does nothing and returns 0: each lookup is checked, or a failure would look like rounded corners.
    const nswin = objc.msgId(view, sel.window); // -[NSView window]
    if (!nswin) throw new Error('the widget NSView has no NSWindow');
    const content = objc.msgId(nswin, sel.contentView); // -[NSWindow contentView]
    if (!content) throw new Error('the widget NSWindow has no content view');
    objc.msgVoidBool(content, sel.setWantsLayer, true); // -[NSView setWantsLayer:(BOOL)]; already YES under Electron
    const layer = objc.msgId(content, sel.layer); // -[NSView layer]
    if (!layer) throw new Error('the widget content view has no layer');
    objc.msgVoidDouble(layer, sel.setCornerRadius, radius); // -[CALayer setCornerRadius:(CGFloat = double)]
    objc.msgVoidBool(layer, sel.setMasksToBounds, true); // -[CALayer setMasksToBounds:(BOOL)]
  }
}
