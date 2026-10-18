import type { MenuItemConstructorOptions } from 'electron';
import type { AppState, WidgetStyle } from '../shared/types';
import { computeWidgetView, type WidgetView } from '../shared/widget-state';

export interface TrayActions {
  showWindow(): void; showSchedule(): void; refreshNow(): void; setStyle(s: WidgetStyle): void; moveWidget(): void;
  openSettings(): void; toggleAutostart(): void; solveCaptcha(): void; quit(): void;
}

const STYLES: [WidgetStyle, string][] = [['compact', 'Компакт'], ['ring', 'Циферблат'], ['timeline', 'Таймлайн']];

const styleItems = (current: WidgetStyle, setStyle: (s: WidgetStyle) => void): MenuItemConstructorOptions[] =>
  STYLES.map(([style, label]) => ({ label, type: 'radio', checked: current === style, click: () => setStyle(style) }));

/** What the tray shows (icon, tooltip, macOS header): the schedule's view, or null before the first snapshot. */
export function trayView(state: AppState, now: Date): WidgetView | null {
  return state.snapshot ? computeWidgetView(state.snapshot, now, state.actual) : null;
}

/** The status and the line under it, as the widget words them when there is no schedule yet. */
function statusLines(state: AppState, view: WidgetView | null): string[] {
  if (view) return [view.title, view.nextText];
  return state.settings.address ? ['Немає даних', 'Графік ще не отримано'] : ['Налаштуйте адресу'];
}

/**
 * On macOS the menu opens with the status of `view` (= trayView, tray-menu.html, D5): two disabled items rather than a
 * `sublabel`, which needs macOS 14.4. Windows keeps its menu as it was.
 */
export function buildTrayMenu(
  state: AppState, a: TrayActions, platform: NodeJS.Platform, view: WidgetView | null,
): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [];
  if (platform === 'darwin') {
    menu.push(...statusLines(state, view).map(label => ({ label, enabled: false })), { type: 'separator' });
  }
  if (state.phase === 'captcha') {
    menu.push({ label: 'Пройти перевірку', click: a.solveCaptcha }, { type: 'separator' });
  }
  menu.push(
    { label: 'Показати графік', click: a.showSchedule },
    { label: 'Оновити зараз', click: a.refreshNow },
    { type: 'separator' },
    { label: 'Стиль віджета', submenu: styleItems(state.settings.widgetStyle, a.setStyle) },
    { label: 'Перемістити віджет', click: a.moveWidget },
    { type: 'separator' },
    { label: 'Налаштування', click: a.openSettings },
    { label: 'Автозапуск', type: 'checkbox', checked: state.settings.autostart, click: a.toggleAutostart },
    { type: 'separator' },
    { label: 'Вийти', click: a.quit },
  );
  return menu;
}

/** Right-click menu of the widget itself. */
export function buildWidgetMenu(
  style: WidgetStyle, a: Pick<TrayActions, 'setStyle' | 'refreshNow' | 'openSettings' | 'quit'>,
): MenuItemConstructorOptions[] {
  return [
    { label: 'Стиль', submenu: styleItems(style, a.setStyle) },
    { label: 'Оновити зараз', click: a.refreshNow },
    { label: 'Налаштування', click: a.openSettings },
    { type: 'separator' },
    { label: 'Вийти', click: a.quit },
  ];
}

export function trayTooltip(view: WidgetView | null): string {
  return view ? `${view.title} · ${view.nextText}` : 'Графік відключень — налаштуйте адресу';
}

/**
 * Base name of the icon file in resources/tray: the state's glyph in the colours of tray-menu.html's light panel, or
 * of its dark panel (`-dark`) on a dark taskbar / menu bar.
 */
export function trayIconFile(view: WidgetView | null, darkPanel: boolean): string {
  return darkPanel ? `${trayIconName(view)}-dark` : trayIconName(view);
}

export function trayIconName(view: WidgetView | null): 'on' | 'off' | 'emergency' | 'unknown' {
  if (!view) return 'unknown';
  switch (view.state) {
    case 'on': return 'on';
    case 'off': case 'maybe-off': return 'off';
    case 'emergency': return 'emergency';
    default: return 'unknown';
  }
}
