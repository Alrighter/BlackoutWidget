// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { App } from '../../src/renderer/src/app/App';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { MainView, RendererApi } from '../../src/shared/ipc';
import { fixtureSnapshot } from '../helpers/snapshot';

afterEach(() => vi.useRealTimers());

test('navigate events switch the in-app view each time', async () => {
  // The fixture is for 2026-10-17 and the schedule tab is labelled with today's date: pin Date (only) to that day.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-17T08:50:00Z'));
  let nav: (v: MainView) => void = () => {};
  const state = { settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok' as const, lineChanged: false };
  const api = {
    getState: vi.fn(async () => state), listProviders: vi.fn(async () => []), onState: vi.fn(() => () => {}),
    onNavigate: vi.fn((cb: (v: MainView) => void) => { nav = cb; return () => {}; }),
  } as unknown as RendererApi;
  render(<App api={api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Налаштування' })).toBeInTheDocument();
  act(() => nav('settings'));
  expect(screen.getByRole('button', { name: 'Оновити зараз' })).toBeInTheDocument();
  act(() => nav('setup'));
  expect(screen.getByRole('heading', { name: 'Компанія' })).toBeInTheDocument();
  act(() => nav('schedule'));
  expect(await screen.findByRole('tab', { name: 'Сьогодні 17.10' })).toBeInTheDocument();
  act(() => nav('setup'));
  expect(screen.getByRole('heading', { name: 'Компанія' })).toBeInTheDocument();
});
