// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from '../../src/renderer/src/app/SettingsView';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { AppState, Settings } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

function mockApi() {
  return {
    setWidgetStyle: vi.fn(async () => {}), setAutostart: vi.fn(async () => {}), refreshNow: vi.fn(async () => {}),
  } as unknown as RendererApi;
}
function stateOf(settings: Partial<Settings> = {}, snapshot: AppState['snapshot'] = fixtureSnapshot()): AppState {
  return {
    settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address, ...settings }, snapshot, phase: 'ok', lineChanged: false, actual: null,
  };
}

test('the address card: the address, then source · line · queue; «Змінити адресу» opens the wizard', async () => {
  const onChangeAddress = vi.fn();
  render(<SettingsView state={stateOf()} api={mockApi()} onChangeAddress={onChangeAddress} />);
  expect(screen.getByRole('heading', { name: 'Адреса' })).toBeInTheDocument();
  expect(screen.getByText('м. Біла Церква, бул. Грушевського Михайла, 40')).toBeInTheDocument();
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1 · черга 1.2')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу' }));
  expect(onChangeAddress).toHaveBeenCalledTimes(1);
});

test('the queue label keeps its abbreviation: «не залучено до ГПВ»', () => {
  const snapshot = { ...fixtureSnapshot(), groupLabel: 'Не залучено до ГПВ' };
  render(<SettingsView state={stateOf({}, snapshot)} api={mockApi()} onChangeAddress={() => {}} />);
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1 · не залучено до ГПВ')).toBeInTheDocument();
});

test('the queue is left out while the schedule is for another queue', () => {
  const address = { ...fixtureSnapshot().address, lineIndex: 2, groupId: 'GPV4.2' };
  render(<SettingsView state={stateOf({ address })} api={mockApi()} onChangeAddress={() => {}} />);
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 2')).toBeInTheDocument();
});

test('style cards: three radios with sizes, the saved one checked; a click saves the style', async () => {
  const api = mockApi();
  render(<SettingsView state={stateOf({ widgetStyle: 'ring' })} api={api} onChangeAddress={() => {}} />);
  const group = screen.getByRole('radiogroup', { name: 'Стиль віджета' });
  const radios = within(group).getAllByRole('radio');
  const names = ['Компакт', 'Циферблат', 'Таймлайн'], sizes = ['290×150', '236×260', '400×200'];
  radios.forEach((r, i) => {
    expect(r).toHaveAccessibleName(names[i]);
    expect(r).toHaveAccessibleDescription(sizes[i]); // the size is announced too
  });
  expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  for (const size of sizes) expect(within(group).getByText(size)).toBeInTheDocument();
  await userEvent.click(within(group).getByRole('radio', { name: 'Таймлайн' }));
  expect(api.setWidgetStyle).toHaveBeenCalledWith('timeline');
});

test('each style card shows its thumbnail: a hidden drawing at the widget\'s proportions', () => {
  render(<SettingsView state={stateOf()} api={mockApi()} onChangeAddress={() => {}} />);
  const radios = within(screen.getByRole('radiogroup', { name: 'Стиль віджета' })).getAllByRole('radio');
  expect(radios.map(r => {
    const svg = r.querySelector('svg.st-thumb-art');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg!.querySelector('rect')).not.toBeNull();
    return svg!.getAttribute('viewBox');
  })).toEqual(['0 0 290 150', '0 0 236 260', '0 0 400 200']);
});

test('the autostart switch is named by its label, shows the setting and flips it', async () => {
  const api = mockApi();
  const { rerender } = render(<SettingsView state={stateOf({ autostart: true })} api={api} onChangeAddress={() => {}} />);
  const sw = screen.getByRole('switch', { name: 'Запускати разом із системою' });
  expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(sw).toHaveAccessibleDescription('Віджет з’явиться після входу');
  await userEvent.click(sw);
  expect(api.setAutostart).toHaveBeenLastCalledWith(false);
  rerender(<SettingsView state={stateOf({ autostart: false })} api={api} onChangeAddress={() => {}} />);
  expect(sw).toHaveAttribute('aria-checked', 'false');
  // The label is a click target too.
  await userEvent.click(screen.getByText('Запускати разом із системою'));
  expect(api.setAutostart).toHaveBeenLastCalledWith(true);
});

test('the schedule row: «Оновлено о HH:MM» of the last fetch; «Оновити зараз» refreshes', async () => {
  const api = mockApi();
  render(<SettingsView state={stateOf({}, fixtureSnapshot({ fetchedAt: '2026-10-17T11:50:00.000Z' }))} api={api} onChangeAddress={() => {}} />);
  expect(screen.getByText('Графік відключень')).toBeInTheDocument();
  expect(screen.getByText('Оновлено о 14:50')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
  expect(api.refreshNow).toHaveBeenCalledTimes(1);
});

test('no schedule yet: the row says so', () => {
  render(<SettingsView state={stateOf({}, null)} api={mockApi()} onChangeAddress={() => {}} />);
  expect(screen.getByText('Дані ще не отримано')).toBeInTheDocument();
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1')).toBeInTheDocument();
});

test('the EcoFlow section sits in the settings with its source chip', () => {
  render(<SettingsView state={stateOf()} api={mockApi()} onChangeAddress={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Фактичний стан світла' })).toBeInTheDocument();
  expect(screen.getByText('EcoFlow')).toBeInTheDocument();
});
