import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { join } from 'node:path';
import type { AppState } from '../shared/types';
import type { WidgetView } from '../shared/widget-state';
import { buildTrayMenu, trayIconFile, trayTooltip, trayView, type TrayActions } from './tray-menu';

export function trayIconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray', `${name}.png`)
    : join(app.getAppPath(), 'resources', 'tray', `${name}.png`);
}

/** On Windows the taskbar's own theme, apart from the apps' one; on macOS the same as shouldUseDarkColors. */
const darkPanel = () => nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;

export class AppTray {
  private readonly tray: Tray;
  private view: WidgetView | null = null;
  private lastIcon: string;

  constructor(private readonly actions: TrayActions) {
    this.lastIcon = trayIconFile(null, darkPanel());
    this.tray = new Tray(nativeImage.createFromPath(trayIconPath(this.lastIcon)));
    this.tray.on('click', actions.showWindow);
    nativeTheme.on('updated', () => this.updateIcon());
  }

  update(state: AppState, now = new Date()): void {
    this.view = trayView(state, now);
    this.updateIcon();
    this.tray.setToolTip(trayTooltip(this.view));
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, this.actions, process.platform, this.view)));
  }

  /** The icon for the last view on the current panel theme; also when only the theme changed. */
  private updateIcon(): void {
    const icon = trayIconFile(this.view, darkPanel());
    if (icon === this.lastIcon) return;
    this.lastIcon = icon;
    this.tray.setImage(nativeImage.createFromPath(trayIconPath(icon)));
  }
}
