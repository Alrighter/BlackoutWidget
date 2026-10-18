// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/src/app/App';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { MainView, RendererApi } from '../../src/shared/ipc';
import { fixtureSnapshot } from '../helpers/snapshot';

afterEach(() => vi.useRealTimers());

// The fixture is for 2026-10-17 and the schedule tab is labelled with today's date: pin Date (only) to that day.
const pinDate = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-17T08:50:00Z')); };
const appState = () => ({ settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok' as const, lineChanged: false });
function fakeApi(extra: Partial<RendererApi> = {}): RendererApi {
  const state = appState();
  return {
    getState: vi.fn(async () => state), listProviders: vi.fn(async () => []), onState: vi.fn(() => () => {}),
    onNavigate: vi.fn(() => () => {}), ...extra,
  } as unknown as RendererApi;
}

test('navigate events switch the in-app view each time', async () => {
  pinDate();
  let nav: (v: MainView) => void = () => {};
  const api = fakeApi({ onNavigate: vi.fn((cb: (v: MainView) => void) => { nav = cb; return () => {}; }) });
  render(<App api={api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Налаштування' })).toBeInTheDocument();
  act(() => nav('settings'));
  expect(screen.getByRole('button', { name: 'Оновити зараз' })).toBeInTheDocument();
  act(() => nav('setup'));
  expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
  act(() => nav('schedule'));
  expect(await screen.findByRole('tab', { name: 'Сьогодні 17.10' })).toBeInTheDocument();
  act(() => nav('setup'));
  expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
});

test('the tab row: «Графік» selected first, ⟳ beside the tabs refreshes now', async () => {
  pinDate();
  const api = fakeApi({ refreshNow: vi.fn(async () => {}) });
  render(<App api={api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
  expect(within(screen.getByRole('tablist', { name: 'Розділи' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['Графік', 'Налаштування']);
  await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
  expect(api.refreshNow).toHaveBeenCalledTimes(1);
});

test.each(['Підключити EcoFlow', 'Підключити'])('«%s» opens the settings with the EcoFlow form open, once', async name => {
  pinDate();
  render(<App api={fakeApi()} view="schedule" />);
  await userEvent.click(await screen.findByRole('button', { name }));
  expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Email')).toBeInTheDocument();
  // Going back and forth by the tabs shows the settings as usual, the form closed.
  await userEvent.click(screen.getByRole('tab', { name: 'Графік' }));
  await userEvent.click(screen.getByRole('tab', { name: 'Налаштування' }));
  expect(screen.queryByLabelText('Email')).toBeNull();
  expect(screen.getByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
});

test('back from the wizard the settings show the EcoFlow form closed', async () => {
  pinDate();
  render(<App api={fakeApi()} view="schedule" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Підключити EcoFlow' }));
  await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Скасувати' }));
  expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByLabelText('Email')).toBeNull();
});
