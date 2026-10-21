import type { MenuItemConstructorOptions } from 'electron';
import { buildTrayMenu, buildWidgetMenu, TOOLTIP_MAX, trayIconFile, trayIconName, trayTooltip, trayView } from '../../src/main/tray-menu';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import { composeAppState } from '../../src/main/compose-state';
import { computeWidgetView } from '../../src/shared/widget-state';
import type { ActualStatus, AppState, Location, LocationState, RefreshPhase, WidgetStyle } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const noop = () => {};
const actions = { showWindow: noop, showSchedule: noop, refreshAll: noop, setStyle: noop, moveWidget: noop, openSettings: noop, toggleAutostart: noop, solveCaptcha: noop, quit: noop };

interface LocOpts { id?: string; style?: WidgetStyle; snapshot?: boolean; phase?: RefreshPhase }
const locState = (name: string, o: LocOpts = {}): LocationState => {
  const location: Location = { id: o.id ?? name, name, address: fixtureSnapshot().address, widgetStyle: o.style ?? 'ring', widgetPosition: null };
  return { location, snapshot: o.snapshot === false ? null : fixtureSnapshot(), phase: o.phase ?? 'ok', lineChanged: false };
};
const stateOf = (locs: LocationState[], actualLocationId: string | null = null, actual?: ActualStatus | null): AppState =>
  composeAppState({ ...DEFAULT_SETTINGS, locations: locs.map(l => l.location), actualLocationId }, locs, actual, true);
const none = () => stateOf([]);
const one = (o: LocOpts = {}) => stateOf([locState('Дім', { id: 'a', ...o })]);
const two = (second: LocOpts = {}) => stateOf([locState('Дім', { id: 'a' }), locState('Батьки', { id: 'b', ...second })]);
// 11:50 Kyiv on the fixture's day: «Світло є» until 15:00.
const T0 = new Date('2026-10-17T08:50:00Z');
const labels = (m: MenuItemConstructorOptions[]) => m.map(i => (i.type === 'separator' ? '—' : i.label));
const menu = (s: AppState, platform: NodeJS.Platform, now = T0, a = actions) => buildTrayMenu(s, a, platform, now);
const sub = (m: MenuItemConstructorOptions[], label: string) => m.find(i => i.label === label)!.submenu as MenuItemConstructorOptions[];

test('menu order and checked items', () => {
  const m = menu(one({ style: 'ring' }), 'win32');
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(
    ['Показати графік', 'Оновити зараз', 'Стиль віджета', 'Перемістити віджет', 'Налаштування', 'Автозапуск', 'Вийти']);
  expect(sub(m, 'Стиль віджета').map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', true], ['Таймлайн', false]]);
  expect(m.find(i => i.label === 'Автозапуск')!.checked).toBe(true);
});

test('one location: style and move act on it directly', () => {
  const setStyle = vi.fn(), moveWidget = vi.fn(), refreshAll = vi.fn();
  const m = menu(one(), 'win32', T0, { ...actions, setStyle, moveWidget, refreshAll });
  (sub(m, 'Стиль віджета')[2].click as () => void)();
  expect(setStyle).toHaveBeenCalledWith('a', 'timeline');
  (m.find(i => i.label === 'Перемістити віджет')!.click as () => void)();
  expect(moveWidget).toHaveBeenCalledWith('a');
  (m.find(i => i.label === 'Оновити зараз')!.click as () => void)();
  expect(refreshAll).toHaveBeenCalled();
});

test('captcha phase puts verification first', () =>
  expect(menu(one({ phase: 'captcha' }), 'win32')[0].label).toBe('Пройти перевірку'));

test('captcha on the second location shows Пройти перевірку', () => {
  const solveCaptcha = vi.fn();
  const m = menu(two({ phase: 'captcha' }), 'win32', T0, { ...actions, solveCaptcha });
  expect(m[0].label).toBe('Пройти перевірку');
  (m[0].click as () => void)();
  expect(solveCaptcha).toHaveBeenCalled();
  expect(labels(menu(two(), 'win32'))).not.toContain('Пройти перевірку');
});

test('Windows has no status header, whatever the state', () => {
  expect(labels(menu(one(), 'win32'))).toEqual(
    ['Показати графік', 'Оновити зараз', '—', 'Стиль віджета', 'Перемістити віджет', '—', 'Налаштування', 'Автозапуск', '—', 'Вийти']);
});

test('two locations: style and move are submenus of names', () => {
  const setStyle = vi.fn(), moveWidget = vi.fn();
  const s = stateOf([locState('Дім', { id: 'a', style: 'compact' }), locState('Батьки', { id: 'b', style: 'timeline' })]);
  const m = menu(s, 'win32', T0, { ...actions, setStyle, moveWidget });
  const style = sub(m, 'Стиль віджета');
  expect(style.map(i => i.label)).toEqual(['Дім', 'Батьки']);
  const radios = (i: MenuItemConstructorOptions) => (i.submenu as MenuItemConstructorOptions[]).map(r => [r.label, r.type, r.checked]);
  expect(radios(style[0])).toEqual([['Компакт', 'radio', true], ['Циферблат', 'radio', false], ['Таймлайн', 'radio', false]]);
  expect(radios(style[1])).toEqual([['Компакт', 'radio', false], ['Циферблат', 'radio', false], ['Таймлайн', 'radio', true]]);
  ((style[1].submenu as MenuItemConstructorOptions[])[1].click as () => void)();
  expect(setStyle).toHaveBeenCalledWith('b', 'ring');
  const move = sub(m, 'Перемістити віджет');
  expect(move.map(i => i.label)).toEqual(['Дім', 'Батьки']);
  (move[1].click as () => void)();
  expect(moveWidget).toHaveBeenCalledWith('b');
});

test('macOS starts with a disabled status header over the next change, then a separator and the Windows menu', () => {
  const s = one();
  const mac = menu(s, 'darwin');
  expect(labels(mac.slice(0, 3))).toEqual(['Світло є', 'Вимкнення о 15:00 · через 3 год 10 хв', '—']);
  expect(mac.slice(0, 2).map(i => [i.enabled, i.click])).toEqual([[false, undefined], [false, undefined]]);
  expect(labels(mac.slice(3))).toEqual(labels(menu(s, 'win32')));
});

test('macOS header shows the view it is given', () => {
  const m = menu(one(), 'darwin', new Date('2026-10-17T09:50:00Z'));
  expect(m[1].label).toBe('Вимкнення о 15:00 · через 2 год 10 хв');
});

test('macOS header keeps its place above the captcha item', () => {
  const m = menu(one({ phase: 'captcha' }), 'darwin');
  expect(labels(m.slice(0, 5))).toEqual(['Світло є', 'Вимкнення о 15:00 · через 3 год 10 хв', '—', 'Пройти перевірку', '—']);
});

test("macOS header without a schedule: the widget's own words", () => {
  const noAddress = menu(none(), 'darwin');
  expect(labels(noAddress.slice(0, 2))).toEqual(['Налаштуйте адресу', '—']);
  expect(noAddress[0].enabled).toBe(false);
  const noSnapshot = menu(one({ snapshot: false }), 'darwin');
  expect(labels(noSnapshot.slice(0, 3))).toEqual(['Немає даних', 'Графік ще не отримано', '—']);
  expect(noSnapshot.slice(0, 2).map(i => i.enabled)).toEqual([false, false]);
});

test('macOS: one disabled line per location', () => {
  const m = menu(two({ snapshot: false }), 'darwin');
  expect(labels(m.slice(0, 3))).toEqual(['Дім: Світло є · Вимкнення о 15:00 · через 3 год 10 хв', 'Батьки: Немає даних', '—']);
  expect(m.slice(0, 2).map(i => [i.enabled, i.click])).toEqual([[false, undefined], [false, undefined]]);
  expect(labels(m.slice(3))).toEqual(labels(menu(two(), 'win32')));
});

test('no locations: the tooltip and the menu say to set an address up', () => {
  expect(trayTooltip(none(), T0)).toBe('Графік відключень — налаштуйте адресу');
  expect(trayView(none(), T0)).toBeNull();
  expect(labels(menu(none(), 'win32'))).not.toContain('Перемістити віджет');
});

test('tooltip: one location as today, several as a line per name', () => {
  expect(trayTooltip(one(), T0)).toBe('Світло є · Вимкнення о 15:00 · через 3 год 10 хв');
  expect(trayTooltip(one({ snapshot: false }), T0)).toBe('Графік відключень — налаштуйте адресу');
});

test('two locations: tooltip lines', () => {
  expect(trayTooltip(two({ snapshot: false }), T0)).toBe('Дім: Світло є · Вимкнення о 15:00 · через 3 год 10 хв\nБатьки: Немає даних');
});

test('tooltip cut to 127', () => {
  const names = ['Перша адреса довга', 'Друга адреса довга', 'Третя адреса довга', 'Четверта адреса довга', "П'ята адреса довга"];
  const s = stateOf(names.map(n => locState(n)));
  const t = trayTooltip(s, T0);
  expect(TOOLTIP_MAX).toBe(127);
  expect(t.length).toBe(127);
  expect(t.endsWith('…')).toBe(true);
  expect(t.startsWith('Перша адреса довга: Світло є')).toBe(true);
});

test('tooltip and icon', () => {
  const v = computeWidgetView(fixtureSnapshot(), T0);
  expect(trayIconName(v)).toBe('on'); expect(trayIconName(null)).toBe('unknown');
  expect(trayIconName({ ...v, state: 'maybe-off' })).toBe('off'); expect(trayIconName({ ...v, state: 'emergency' })).toBe('emergency');
});
test("icon file: the state's glyph in the light- or dark-panel colours", () => {
  const v = computeWidgetView(fixtureSnapshot(), T0);
  const cases = [[null, 'unknown'], [v, 'on'], [{ ...v, state: 'off' as const }, 'off'], [{ ...v, state: 'emergency' as const }, 'emergency']] as const;
  for (const [view, name] of cases) {
    expect(trayIconFile(view, false)).toBe(name);
    expect(trayIconFile(view, true)).toBe(`${name}-dark`);
  }
});
test('tray view: none before the first snapshot', () => {
  expect(trayView(one({ snapshot: false }), T0)).toBeNull();
  expect(trayView(one(), T0)?.title).toBe('Світло є');
});

test('the icon follows the first location', () => {
  const s = stateOf([locState('Дім', { id: 'a', snapshot: false }), locState('Батьки', { id: 'b' })]);
  expect(trayView(s, T0)).toBeNull();
  expect(trayView(two({ snapshot: false }), T0)?.title).toBe('Світло є');
});

test("the icon uses the first location's own actual, only if it is the EcoFlow location", () => {
  const off: ActualStatus = { sourceLabel: 'EcoFlow', power: 'off', since: '2026-10-17T08:00:00Z', history: [] };
  const ecoOnFirst = stateOf([locState('Дім', { id: 'a' }), locState('Батьки', { id: 'b' })], 'a', off);
  const ecoOnSecond = stateOf([locState('Дім', { id: 'a' }), locState('Батьки', { id: 'b' })], 'b', off);
  expect(trayView(ecoOnFirst, T0)).toEqual(computeWidgetView(fixtureSnapshot(), T0, off));
  expect(trayView(ecoOnSecond, T0)).toEqual(computeWidgetView(fixtureSnapshot(), T0, undefined));
});

test('widget context menu: style, refresh, settings, quit', () => {
  const setStyle = vi.fn();
  const m = buildWidgetMenu('timeline', { ...actions, setStyle, refreshNow: noop });
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(['Стиль', 'Оновити зараз', 'Налаштування', 'Вийти']);
  const style = m[0].submenu as MenuItemConstructorOptions[];
  expect(style.map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', false], ['Таймлайн', true]]);
  (style[1].click as () => void)();
  expect(setStyle).toHaveBeenCalledWith('ring');
});
