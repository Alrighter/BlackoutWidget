import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import type { AppState } from '../shared/types';
import { computeWidgetView } from '../shared/widget-state';
import { buildTrayMenu, trayIconName, trayTooltip, type TrayActions } from './tray-menu';

export function trayIconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray', `${name}.png`)
    : join(app.getAppPath(), 'resources', 'tray', `${name}.png`);
}

export class AppTray {
  private readonly tray: Tray;
  private lastIcon: string | null = null;

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(nativeImage.createFromPath(trayIconPath('unknown')));
    this.tray.on('click', actions.showWindow);
  }

  update(state: AppState, now = new Date()): void {
    const view = state.snapshot ? computeWidgetView(state.snapshot, now, state.actual) : null;
    const icon = trayIconName(view);
    if (icon !== this.lastIcon) {
      this.lastIcon = icon;
      this.tray.setImage(nativeImage.createFromPath(trayIconPath(icon)));
    }
    this.tray.setToolTip(trayTooltip(view));
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, this.actions)));
  }
}
