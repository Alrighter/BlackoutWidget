import type { MenuItemConstructorOptions } from 'electron';
import { buildTrayMenu, buildWidgetMenu, trayIconName, trayTooltip } from '../../src/main/tray-menu';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import { computeWidgetView } from '../../src/shared/widget-state';
import type { AppState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const noop = () => {};
const actions = { showWindow: noop, showSchedule: noop, refreshNow: noop, setStyle: noop, moveWidget: noop, openSettings: noop, toggleAutostart: noop, solveCaptcha: noop, quit: noop };
const state = (p: Partial<AppState> = {}): AppState => ({ settings: { ...DEFAULT_SETTINGS, widgetStyle: 'ring' }, snapshot: null, phase: 'ok', lineChanged: false, ...p });
const withSnapshot = (p: Partial<AppState> = {}) =>
  state({ settings: { ...DEFAULT_SETTINGS, widgetStyle: 'ring', address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), ...p });
// 11:50 Kyiv on the fixture's day: «Світло є» until 15:00.
const T0 = new Date('2026-10-17T08:50:00Z');
const labels = (m: MenuItemConstructorOptions[]) => m.map(i => (i.type === 'separator' ? '—' : i.label));

test('menu order and checked items', () => {
  const m = buildTrayMenu(state(), actions, 'win32');
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(
    ['Показати графік', 'Оновити зараз', 'Стиль віджета', 'Перемістити віджет', 'Налаштування', 'Автозапуск', 'Вийти']);
  const style = m.find(i => i.label === 'Стиль віджета')!.submenu as MenuItemConstructorOptions[];
  expect(style.map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', true], ['Таймлайн', false]]);
  expect(m.find(i => i.label === 'Автозапуск')!.checked).toBe(true);
});
test('captcha phase puts verification first', () =>
  expect(buildTrayMenu(state({ phase: 'captcha' }), actions, 'win32')[0].label).toBe('Пройти перевірку'));

test('Windows has no status header, whatever the state', () => {
  expect(labels(buildTrayMenu(withSnapshot(), actions, 'win32', T0))).toEqual(
    ['Показати графік', 'Оновити зараз', '—', 'Стиль віджета', 'Перемістити віджет', '—', 'Налаштування', 'Автозапуск', '—', 'Вийти']);
});

test('macOS starts with a disabled status header over the next change, then a separator and the Windows menu', () => {
  const s = withSnapshot();
  const mac = buildTrayMenu(s, actions, 'darwin', T0);
  expect(labels(mac.slice(0, 3))).toEqual(['Світло є', 'Вимкнення о 15:00 · через 3 год 10 хв', '—']);
  expect(mac.slice(0, 2).map(i => [i.enabled, i.click])).toEqual([[false, undefined], [false, undefined]]);
  expect(labels(mac.slice(3))).toEqual(labels(buildTrayMenu(s, actions, 'win32', T0)));
});

test('macOS header follows the clock it is given', () => {
  const m = buildTrayMenu(withSnapshot(), actions, 'darwin', new Date('2026-10-17T09:50:00Z'));
  expect(m[1].label).toBe('Вимкнення о 15:00 · через 2 год 10 хв');
});

test('macOS header keeps its place above the captcha item', () => {
  const m = buildTrayMenu(withSnapshot({ phase: 'captcha' }), actions, 'darwin', T0);
  expect(labels(m.slice(0, 5))).toEqual(['Світло є', 'Вимкнення о 15:00 · через 3 год 10 хв', '—', 'Пройти перевірку', '—']);
});

test('macOS header without a schedule: the widget\'s own words', () => {
  const noAddress = buildTrayMenu(state(), actions, 'darwin', T0);
  expect(labels(noAddress.slice(0, 2))).toEqual(['Налаштуйте адресу', '—']);
  expect(noAddress[0].enabled).toBe(false);
  const noSnapshot = buildTrayMenu(state({ settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address } }), actions, 'darwin', T0);
  expect(labels(noSnapshot.slice(0, 3))).toEqual(['Немає даних', 'Графік ще не отримано', '—']);
  expect(noSnapshot.slice(0, 2).map(i => i.enabled)).toEqual([false, false]);
});

test('tooltip and icon', () => {
  expect(trayTooltip(null)).toBe('Графік відключень — налаштуйте адресу');
  const v = computeWidgetView(fixtureSnapshot(), T0);
  expect(trayTooltip(v)).toBe('Світло є · Вимкнення о 15:00 · через 3 год 10 хв');
  expect(trayIconName(v)).toBe('on'); expect(trayIconName(null)).toBe('unknown');
  expect(trayIconName({ ...v, state: 'maybe-off' })).toBe('off'); expect(trayIconName({ ...v, state: 'emergency' })).toBe('emergency');
});
test('widget context menu: style, refresh, settings, quit', () => {
  const setStyle = vi.fn();
  const m = buildWidgetMenu('timeline', { ...actions, setStyle });
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(['Стиль', 'Оновити зараз', 'Налаштування', 'Вийти']);
  const style = m[0].submenu as MenuItemConstructorOptions[];
  expect(style.map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', false], ['Таймлайн', true]]);
  (style[1].click as () => void)();
  expect(setStyle).toHaveBeenCalledWith('ring');
});
