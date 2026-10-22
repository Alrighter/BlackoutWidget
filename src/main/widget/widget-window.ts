import { app, BrowserWindow, Menu, screen, type MenuItemConstructorOptions, type Rectangle, type WebContents } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/ipc';
import type { WidgetBackground, WidgetPosition, WidgetStyle } from '../../shared/types';
import { WIDGET_RADII, WIDGET_SIZES } from '../../shared/widget-sizes';
import { silentLogger, type Logger } from '../log';
import type { AppStore } from '../store';
import type { DesktopPinner } from './desktop-pin';
import type { NativeGlass } from './glass-darwin';
import { placeWidget } from './position';
import { roundedShape } from './shape';

const REBUILD_MS = 1000;
const NATIVE: WidgetBackground = { kind: 'native' };
const TINT: WidgetBackground = { kind: 'tint' };

export interface WidgetWindowDeps {
  locationId: string;
  store: AppStore;
  /** This widget's own pinner: a pinner tracks one window, and dispose() disposes it. */
  pinner: DesktopPinner;
  preload: string;
  log?: Logger;
  /** The other widgets' bounds (DIP). */
  otherBounds(): Rectangle[];
  /** True once the app is quitting. */
  quitting(): boolean;
  /** macOS: the windows' native glass, shared by every widget; absent or null elsewhere (Windows paints the wallpaper crop instead). */
  glass?: NativeGlass | null;
  /** Test seam; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * One location's desktop widget: a transparent frameless window pinned to the desktop. It owns its DIP bounds
 * (a pinned child window's own idea of its bounds is not trusted) and saves the position to its own location after
 * every drag / move mode. Main keeps one per location and disposes it, for good, when the location is deleted. On macOS
 * its glass is native vibrancy, rounded to the card of the current style, and it sends the renderer `native` or `tint`.
 */
export class WidgetWindow {
  readonly locationId: string;
  private win: BrowserWindow | null = null;
  private style: WidgetStyle;
  private bounds: Rectangle;
  private dragFrom: { x: number; y: number; screenX: number; screenY: number } | null = null;
  private moveMode = false;
  private background: WidgetBackground | null = null;
  /** macOS: the current window was created with the native glass's vibrancy, not yet taken off. */
  private vibrant = false;
  private disposed = false;
  private rebuild: ReturnType<typeof setTimeout> | null = null;
  private readonly movedListeners = new Set<() => void>();

  constructor(private readonly deps: WidgetWindowDeps) {
    this.locationId = deps.locationId;
    // Main builds a widget only for a location in settings; a missing one (deleted meanwhile) is disposed on the next reconcile.
    const location = deps.store.getLocation(deps.locationId);
    this.style = location?.widgetStyle ?? 'compact';
    this.bounds = this.layout(location?.widgetPosition ?? null).rect;
  }

  show(): void {
    if (this.disposed) return;
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
  }

  /** Re-reads the location's style and applies a change: the top-left corner stays, the size becomes the new style's. */
  sync(): void {
    const location = this.disposed ? null : this.deps.store.getLocation(this.locationId);
    if (!location || location.widgetStyle === this.style) return;
    this.style = location.widgetStyle;
    this.setBounds(this.layout(location.widgetPosition).rect);
    if (this.win) {
      this.applyShape(this.win);
      this.applyGlass(this.win); // every style change, from the settings or the tray, comes through here
    }
    this.emitMoved();
  }

  /**
   * A monitor came or went (or its work area / scale changed): back to the saved position (no saved position: the
   * primary display's corner), or — its display gone — to a free spot on the primary display, clear of the other
   * widgets. That spot is not saved, so the widget returns with its display. Main calls it on every widget in
   * location order, so each one finds its own spot.
   */
  refit(): void {
    if (this.disposed || this.dragFrom) return;
    const location = this.deps.store.getLocation(this.locationId);
    if (!location) return;
    this.setBounds(this.layout(location.widgetPosition).rect);
    this.emitMoved();
  }

  /** True when `contents` is this widget's renderer: main maps a widget's IPC to its widget by the sender. */
  owns(contents: WebContents): boolean {
    const win = this.win;
    return !!win && !win.isDestroyed() && win.webContents === contents;
  }

  /**
   * For good: the window goes (destroy, not close: the close guard would keep it), no rebuild follows, and the
   * listeners and the pinner stop. Idempotent; show() does nothing afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rebuild) clearTimeout(this.rebuild);
    this.rebuild = null;
    this.moveMode = false;
    this.dragFrom = null;
    this.movedListeners.clear();
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    this.deps.pinner.dispose();
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  /** Remembers the background and (re)sends it on every renderer load, so a send before the renderer subscribed is not lost. */
  setBackground(background: WidgetBackground): void {
    this.background = background;
    this.send(IPC.background, background);
  }

  /** New position = position at 'start' + cursor travel since 'start' (screen DIP); 'end' clamps and saves. */
  drag(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void {
    if (phase === 'start') {
      this.dragFrom = { x: this.bounds.x, y: this.bounds.y, screenX, screenY };
      return;
    }
    const from = this.dragFrom;
    if (!from) return;
    const rect = {
      ...this.bounds, x: Math.round(from.x + screenX - from.screenX), y: Math.round(from.y + screenY - from.screenY),
    };
    if (phase === 'move') {
      this.setBounds(rect);
      return;
    }
    this.dragFrom = null;
    this.commit(rect);
    this.emitMoved();
  }

  /** Fallback for desktops where the pinned widget gets no mouse input (spec §7.3): unpin, float, drag, «Готово». */
  beginMoveMode(): void {
    const win = this.win;
    if (this.moveMode || !win || win.isDestroyed()) return;
    this.moveMode = true;
    this.deps.pinner.unpin(win);
    win.setAlwaysOnTop(true);
    this.send(IPC.widgetMoveMode, true);
  }

  endMoveMode(): void {
    const win = this.win;
    if (!this.moveMode || !win || win.isDestroyed()) return;
    this.moveMode = false;
    this.dragFrom = null;
    this.commit(this.bounds);
    win.setAlwaysOnTop(false); // before the pin: on macOS setAlwaysOnTop rewrites the window level the pin sets
    this.deps.pinner.pin(win);
    this.send(IPC.widgetMoveMode, false);
    this.emitMoved();
  }

  popupMenu(template: MenuItemConstructorOptions[]): void {
    if (this.win && !this.win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  getBoundsDip(): Rectangle {
    return { ...this.bounds };
  }

  /** Fires whenever the widget's bounds settle somewhere new (drag end, move mode end, style or display change). Returns an unsubscribe. */
  onMoved(cb: () => void): () => void {
    this.movedListeners.add(cb);
    return () => { this.movedListeners.delete(cb); };
  }

  private emitMoved(): void {
    for (const cb of [...this.movedListeners]) {
      try { cb(); } catch (err) { console.error('widget onMoved listener failed', err); }
    }
  }

  private layout(pos: WidgetPosition | null): { pos: WidgetPosition; rect: Rectangle } {
    const size = WIDGET_SIZES[this.style];
    const placed = placeWidget(pos, size, screen.getAllDisplays(), screen.getPrimaryDisplay().id, this.deps.otherBounds());
    return { pos: placed, rect: { x: placed.x, y: placed.y, ...size } };
  }

  /** Clamps the rect into the display it mostly lies on, applies it and saves it to this widget's location only. */
  private commit(rect: Rectangle): void {
    if (!this.deps.store.getLocation(this.locationId)) return; // deleted meanwhile: this widget is about to go
    const { pos, rect: placed } = this.layout({ x: rect.x, y: rect.y, displayId: screen.getDisplayMatching(rect).id });
    this.setBounds(placed);
    try {
      this.deps.store.updateLocation(this.locationId, l => ({ ...l, widgetPosition: pos }));
    } catch (err) {
      // Runs from IPC / tray events: a settings file that can't be read right now must not become an uncaught error.
      (this.deps.log ?? silentLogger).error(`saving the widget position failed (location ${this.locationId})`, err);
    }
  }

  private setBounds(rect: Rectangle): void {
    this.bounds = rect;
    if (this.win && !this.win.isDestroyed()) this.deps.pinner.setBounds(this.win, rect);
  }

  /**
   * Windows: cuts the window to the card's rounded corners. The desktop then owns the corners: its selection rectangle
   * and icons show there (a pinned window's transparent pixels still hide them) and clicks there reach it.
   */
  private applyShape(win: BrowserWindow): void {
    if (this.platform() !== 'win32' || win.isDestroyed()) return;
    const { width, height } = WIDGET_SIZES[this.style];
    win.setShape(roundedShape(width, height, WIDGET_RADII[this.style]));
  }

  /** The explorer-restart recovery is for a live widget only: never once it is disposed or the app is quitting. */
  private mayRebuild(): boolean {
    return !this.deps.quitting() && !this.disposed;
  }

  /**
   * macOS: rounds the native glass to the current card and tells the renderer to draw over it (`native`). If that
   * fails (the glass logged it), the vibrancy goes too, since unrounded it would show as a blurred rectangle around the
   * card, and the renderer falls back to the tint glass; the glass stays off, so later windows get no vibrancy. The
   * glass is shared: once another widget's rounding turned it off, this one drops its vibrancy the same way.
   */
  private applyGlass(win: BrowserWindow): void {
    const glass = this.deps.glass;
    if (!glass || win.isDestroyed()) return;
    if (glass.enabled && glass.round(win, this.style)) {
      if (this.background?.kind !== 'native') this.setBackground(NATIVE);
      return;
    }
    if (!this.vibrant) return; // created without vibrancy (the glass was already off): the renderer keeps its tint
    this.vibrant = false;
    win.setVibrancy(null);
    this.setBackground(TINT);
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private create(): BrowserWindow {
    // macOS: vibrancy with the window kept transparent (clear and non-opaque outside the rounded content); {} elsewhere.
    const glassOptions = this.deps.glass?.windowOptions() ?? {};
    this.vibrant = !!glassOptions.vibrancy;
    const win = new BrowserWindow({
      ...this.bounds, show: false,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: true, hasShadow: false,
      ...glassOptions,
      // macOS, glass or not: the app (LSUIElement) is almost never active, so without acceptFirstMouse the first left
      // press (open the schedule, start a drag, «Готово») would only activate it; and Cmd+M must not minimize the widget.
      ...(this.platform() === 'darwin' ? { acceptFirstMouse: true, minimizable: false } : {}),
      // No background throttling: a pinned, occluded widget must keep its minute clock running.
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.once('ready-to-show', () => {
      // While still top-level: Electron may create the window a few px off the asked size at fractional scaling,
      // and its first show re-applies its own (screen-coordinate) bounds; both must happen before it becomes a child.
      this.deps.pinner.setBounds(win, this.bounds);
      this.applyShape(win);
      this.applyGlass(win); // after the vibrancy (applied at construction) and before the first frame shows
      win.showInactive();
      // Last: on macOS nothing after the pin may reset the level (no setAlwaysOnTop / setVisibleOnAllWorkspaces).
      this.deps.pinner.pin(win);
    });
    win.on('close', e => { if (!this.deps.quitting()) e.preventDefault(); }); // e.g. Alt+F4 must not remove the widget
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.moveMode = false;
      this.dragFrom = null;
      // Restarting explorer.exe destroys the desktop window's children, this one included: build a new one.
      if (!this.mayRebuild()) return;
      if (this.rebuild) clearTimeout(this.rebuild);
      this.rebuild = setTimeout(() => {
        this.rebuild = null;
        if (this.mayRebuild()) this.show();
      }, REBUILD_MS);
    });
    win.webContents.on('did-finish-load', () => {
      if (this.moveMode) win.webContents.send(IPC.widgetMoveMode, true); // renderer reloaded mid move mode
      if (this.background) win.webContents.send(IPC.background, this.background);
    });
    if (!app.isPackaged) win.webContents.on('console-message', e => console.log(`[widget] ${e.message}`));
    const url = process.env.ELECTRON_RENDERER_URL;
    const loading = url ? win.loadURL(`${url}/widget.html`) : win.loadFile(join(__dirname, '../renderer/widget.html'));
    loading.catch(err => console.error('widget window load failed', err));
    return win;
  }
}
