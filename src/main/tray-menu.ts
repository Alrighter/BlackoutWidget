import type { MenuItemConstructorOptions } from 'electron';
import type { AppState, WidgetStyle } from '../shared/types';
import type { WidgetView } from '../shared/widget-state';

export interface TrayActions {
  showSchedule(): void; refreshNow(): void; setStyle(s: WidgetStyle): void; moveWidget(): void;
  openSettings(): void; toggleAutostart(): void; solveCaptcha(): void; quit(): void;
}

const STYLES: [WidgetStyle, string][] = [['compact', 'Компакт'], ['ring', 'Циферблат'], ['timeline', 'Таймлайн']];

export function buildTrayMenu(state: AppState, a: TrayActions): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [];
  if (state.phase === 'captcha') {
    menu.push({ label: 'Пройти перевірку', click: a.solveCaptcha }, { type: 'separator' });
  }
  menu.push(
    { label: 'Показати графік', click: a.showSchedule },
    { label: 'Оновити зараз', click: a.refreshNow },
    { type: 'separator' },
    {
      label: 'Стиль віджета',
      submenu: STYLES.map(([style, label]): MenuItemConstructorOptions => ({
        label, type: 'radio', checked: state.settings.widgetStyle === style, click: () => a.setStyle(style),
      })),
    },
    { label: 'Перемістити віджет', click: a.moveWidget },
    { type: 'separator' },
    { label: 'Налаштування', click: a.openSettings },
    { label: 'Автозапуск', type: 'checkbox', checked: state.settings.autostart, click: a.toggleAutostart },
    { type: 'separator' },
    { label: 'Вийти', click: a.quit },
  );
  return menu;
}

export function trayTooltip(view: WidgetView | null): string {
  return view ? `${view.title} · ${view.nextText}` : 'Графік відключень — налаштуйте адресу';
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
