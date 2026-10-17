import type { MenuItemConstructorOptions } from 'electron';
import { buildTrayMenu, trayIconName, trayTooltip } from '../../src/main/tray-menu';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import { computeWidgetView } from '../../src/shared/widget-state';
import type { AppState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const noop = () => {};
const actions = { showWindow: noop, showSchedule: noop, refreshNow: noop, setStyle: noop, moveWidget: noop, openSettings: noop, toggleAutostart: noop, solveCaptcha: noop, quit: noop };
const state = (p: Partial<AppState> = {}): AppState => ({ settings: { ...DEFAULT_SETTINGS, widgetStyle: 'ring' }, snapshot: null, phase: 'ok', lineChanged: false, ...p });

test('menu order and checked items', () => {
  const m = buildTrayMenu(state(), actions);
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(
    ['Показати графік', 'Оновити зараз', 'Стиль віджета', 'Перемістити віджет', 'Налаштування', 'Автозапуск', 'Вийти']);
  const style = m.find(i => i.label === 'Стиль віджета')!.submenu as MenuItemConstructorOptions[];
  expect(style.map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', true], ['Таймлайн', false]]);
  expect(m.find(i => i.label === 'Автозапуск')!.checked).toBe(true);
});
test('captcha phase puts verification first', () =>
  expect(buildTrayMenu(state({ phase: 'captcha' }), actions)[0].label).toBe('Пройти перевірку'));
test('tooltip and icon', () => {
  expect(trayTooltip(null)).toBe('Графік відключень — налаштуйте адресу');
  const v = computeWidgetView(fixtureSnapshot(), new Date('2026-10-17T08:50:00Z'));
  expect(trayTooltip(v)).toBe('Світло є · Вимкнення о 15:00 · через 3 год 10 хв');
  expect(trayIconName(v)).toBe('on'); expect(trayIconName(null)).toBe('unknown');
  expect(trayIconName({ ...v, state: 'maybe-off' })).toBe('off'); expect(trayIconName({ ...v, state: 'emergency' })).toBe('emergency');
});
