import { app, BrowserWindow, Menu, screen, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/ipc';
import type { WidgetBackground, WidgetPosition, WidgetStyle } from '../../shared/types';
import { WIDGET_SIZES } from '../../shared/widget-sizes';
import { silentLogger, type Logger } from '../log';
import type { AppStore } from '../store';
import type { DesktopPinner } from './desktop-pin';
import type { NativeGlass } from './glass-darwin';
import { placeWidget } from './position';

export interface WidgetWindowDeps {
  store: AppStore; pinner: DesktopPinner; preload: string; log?: Logger;
  /** macOS: the window's native glass; absent or null elsewhere (Windows paints the wallpaper crop instead). */
  glass?: NativeGlass | null;
}

const NATIVE: WidgetBackground = { kind: 'native' };
const TINT: WidgetBackground = { kind: 'tint' };

/**
 * The desktop widget: a transparent frameless window pinned to the desktop. It owns its DIP bounds (a pinned
 * child window's own idea of its bounds is not trusted) and saves the position after every drag / move mode. On macOS
 * its glass is native vibrancy, rounded to the card of the current style, and it sends the renderer `native` or `tint`.
 */
export class WidgetWindow {
  private win: BrowserWindow | null = null;
  private style: WidgetStyle;
  private bounds: Rectangle;
  private dragFrom: { x: number; y: number; screenX: number; screenY: number } | null = null;
  private moveMode = false;
  private background: WidgetBackground | null = null;
  private quitting = false;
  private readonly movedListeners: (() => void)[] = [];

  constructor(private readonly deps: WidgetWindowDeps) {
    const settings = deps.store.getSettings();
    this.style = settings.widgetStyle;
    this.bounds = this.layout(settings.widgetPosition).rect;
    app.on('before-quit', () => { this.quitting = true; });
    // A monitor coming or going (or its work area / scale changing): put the widget back where it was saved,
    // or on the primary display if that monitor is gone.
    const refit = () => this.refit();
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    screen.on('display-metrics-changed', refit);
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
  }

  setStyle(style: WidgetStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.setBounds(this.layout(this.deps.store.getSettings().widgetPosition).rect);
    if (this.win) this.applyGlass(this.win); // every style change, from the settings or the tray, comes through here
    this.emitMoved();
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

  /** Fires whenever the widget's bounds settle somewhere new (drag end, move mode end, style or display change). */
  onMoved(cb: () => void): void {
    this.movedListeners.push(cb);
  }

  private emitMoved(): void {
    for (const cb of this.movedListeners) {
      try { cb(); } catch (err) { console.error('widget onMoved listener failed', err); }
    }
  }

  private layout(pos: WidgetPosition | null): { pos: WidgetPosition; rect: Rectangle } {
    const size = WIDGET_SIZES[this.style];
    const placed = placeWidget(pos, size, screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    return { pos: placed, rect: { x: placed.x, y: placed.y, ...size } };
  }

  /** Clamps the rect into the display it mostly lies on, applies and saves it. */
  private commit(rect: Rectangle): void {
    const { pos, rect: placed } = this.layout({ x: rect.x, y: rect.y, displayId: screen.getDisplayMatching(rect).id });
    this.setBounds(placed);
    try {
      this.deps.store.updateSettings({ widgetPosition: pos });
    } catch (err) {
      // Runs from IPC / tray events: a settings file that can't be read right now must not become an uncaught error.
      (this.deps.log ?? silentLogger).error('saving the widget position failed', err);
    }
  }

  private setBounds(rect: Rectangle): void {
    this.bounds = rect;
    if (this.win && !this.win.isDestroyed()) this.deps.pinner.setBounds(this.win, rect);
  }

  private refit(): void {
    if (this.dragFrom) return;
    this.setBounds(this.layout(this.deps.store.getSettings().widgetPosition).rect);
    this.emitMoved();
  }

  /**
   * macOS: rounds the native glass to the current card and tells the renderer to draw over it (`native`). If that
   * fails (the glass logged it), the vibrancy goes too, since unrounded it would show as a blurred rectangle around the
   * card, and the renderer falls back to the tint glass; the glass stays off, so later windows get no vibrancy.
   */
  private applyGlass(win: BrowserWindow): void {
    const glass = this.deps.glass;
    if (!glass?.enabled || win.isDestroyed()) return;
    if (glass.round(win, this.style)) {
      if (this.background?.kind !== 'native') this.setBackground(NATIVE);
      return;
    }
    win.setVibrancy(null);
    this.setBackground(TINT);
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      ...this.bounds, show: false,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: true, hasShadow: false,
      // macOS: vibrancy with the window kept transparent (clear and non-opaque outside the rounded content); {} elsewhere.
      ...this.deps.glass?.windowOptions(),
      // No background throttling: a pinned, occluded widget must keep its minute clock running.
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.once('ready-to-show', () => {
      // While still top-level: Electron may create the window a few px off the asked size at fractional scaling,
      // and its first show re-applies its own (screen-coordinate) bounds; both must happen before it becomes a child.
      this.deps.pinner.setBounds(win, this.bounds);
      this.applyGlass(win); // after the vibrancy (applied at construction) and before the first frame shows
      win.showInactive();
      // Last: on macOS nothing after the pin may reset the level (no setAlwaysOnTop / setVisibleOnAllWorkspaces).
      this.deps.pinner.pin(win);
    });
    win.on('close', e => { if (!this.quitting) e.preventDefault(); }); // e.g. Alt+F4 must not remove the widget
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.moveMode = false;
      this.dragFrom = null;
      // Restarting explorer.exe destroys the desktop window's children, this one included: build a new one.
      if (!this.quitting) setTimeout(() => { if (!this.quitting) this.show(); }, 1000);
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
