import type { MenuItemConstructorOptions } from 'electron';
import type { AppState, LocationState, WidgetStyle } from '../shared/types';
import { computeWidgetView, type WidgetView } from '../shared/widget-state';

export interface TrayActions {
  showWindow(): void; showSchedule(): void; refreshAll(): void;
  setStyle(locationId: string, s: WidgetStyle): void; moveWidget(locationId: string): void;
  openSettings(): void; toggleAutostart(): void; solveCaptcha(): void; quit(): void;
}

/** The longest tooltip Windows shows (a NOTIFYICONDATA szTip is 128 characters with its terminator). */
export const TOOLTIP_MAX = 127;

const STYLES: [WidgetStyle, string][] = [['compact', 'Компакт'], ['ring', 'Циферблат'], ['timeline', 'Таймлайн']];

const styleItems = (current: WidgetStyle, setStyle: (s: WidgetStyle) => void): MenuItemConstructorOptions[] =>
  STYLES.map(([style, label]) => ({ label, type: 'radio', checked: current === style, click: () => setStyle(style) }));

/** A location's own view, with the station status only if this is the EcoFlow location. */
const viewOf = (l: LocationState, now: Date): WidgetView | null =>
  l.snapshot ? computeWidgetView(l.snapshot, now, l.actual) : null;

/** What the tray shows (icon, tooltip, macOS header) with one location: the first location's view, or null before its first snapshot. */
export function trayView(state: AppState, now: Date): WidgetView | null {
  const first = state.locations[0];
  return first ? viewOf(first, now) : null;
}

/** One line per location, as the tooltip and the macOS header word it. */
const locationLine = (l: LocationState, now: Date): string => {
  const view = viewOf(l, now);
  return view ? `${l.location.name}: ${view.title} · ${view.nextText}` : `${l.location.name}: Немає даних`;
};

/** The status and the line under it, as the widget words them when there is no schedule yet. */
function statusLines(state: AppState, now: Date): string[] {
  const view = trayView(state, now);
  if (view) return [view.title, view.nextText];
  return state.locations.length > 0 ? ['Немає даних', 'Графік ще не отримано'] : ['Налаштуйте адресу'];
}

/** Per-location choices: the radios themselves with one location, a submenu of names holding them with several. */
function perLocation(
  state: AppState, label: string, items: (l: LocationState) => MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  if (state.locations.length === 0) return [];
  if (state.locations.length === 1) return [{ label, submenu: items(state.locations[0]) }];
  return [{ label, submenu: state.locations.map(l => ({ label: l.location.name, submenu: items(l) })) }];
}

/**
 * On macOS the menu opens with the status of the tray's view (tray-menu.html, D5): two disabled items rather than a
 * `sublabel`, which needs macOS 14.4 — one disabled line per location with several. Windows keeps its menu as it was.
 */
export function buildTrayMenu(
  state: AppState, a: TrayActions, platform: NodeJS.Platform, now: Date,
): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [];
  const locations = state.locations;
  if (platform === 'darwin') {
    const lines = locations.length > 1 ? locations.map(l => locationLine(l, now)) : statusLines(state, now);
    menu.push(...lines.map(label => ({ label, enabled: false })), { type: 'separator' });
  }
  if (locations.some(l => l.phase === 'captcha')) {
    menu.push({ label: 'Пройти перевірку', click: () => a.solveCaptcha() }, { type: 'separator' });
  }
  menu.push(
    { label: 'Показати графік', click: () => a.showSchedule() },
    { label: 'Оновити зараз', click: () => a.refreshAll() },
    { type: 'separator' },
    ...perLocation(state, 'Стиль віджета', l => styleItems(l.location.widgetStyle, s => a.setStyle(l.location.id, s))),
  );
  if (locations.length === 1) {
    menu.push({ label: 'Перемістити віджет', click: () => a.moveWidget(locations[0].location.id) });
  } else if (locations.length > 1) {
    menu.push({
      label: 'Перемістити віджет',
      submenu: locations.map(l => ({ label: l.location.name, click: () => a.moveWidget(l.location.id) })),
    });
  }
  menu.push(
    { type: 'separator' },
    { label: 'Налаштування', click: () => a.openSettings() },
    { label: 'Автозапуск', type: 'checkbox', checked: state.settings.autostart, click: () => a.toggleAutostart() },
    { type: 'separator' },
    { label: 'Вийти', click: () => a.quit() },
  );
  return menu;
}

/** Right-click menu of the widget itself. */
export function buildWidgetMenu(
  style: WidgetStyle,
  a: { setStyle(s: WidgetStyle): void; refreshNow(): void; openSettings(): void; quit(): void },
): MenuItemConstructorOptions[] {
  return [
    { label: 'Стиль', submenu: styleItems(style, a.setStyle) },
    { label: 'Оновити зараз', click: a.refreshNow },
    { label: 'Налаштування', click: a.openSettings },
    { type: 'separator' },
    { label: 'Вийти', click: a.quit },
  ];
}

/** With one location the line as today (no name); with several a line per location, cut to TOOLTIP_MAX. */
export function trayTooltip(state: AppState, now: Date): string {
  if (state.locations.length > 1) {
    const text = state.locations.map(l => locationLine(l, now)).join('\n');
    return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
  }
  const view = trayView(state, now);
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
