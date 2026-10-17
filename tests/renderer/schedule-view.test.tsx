// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleView } from '../../src/renderer/src/app/ScheduleView';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { ActualPower, ActualSegment, AppState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

test('shows source time and unpublished tomorrow', async () => {
  const state: AppState = { settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false };
  render(<ScheduleView state={state} now={new Date('2026-10-17T08:50:00Z')} api={{} as RendererApi} />);
  expect(screen.getByText('Оновлено о 11:48 · графік ДТЕК від 17.10.2026 11:55')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
  expect(screen.getByText('Графік на завтра ще не опубліковано')).toBeInTheDocument();
});
test('captcha banner calls solveCaptcha', async () => {
  const api = { solveCaptcha: vi.fn(async () => {}) } as unknown as RendererApi;
  render(<ScheduleView state={{ settings: DEFAULT_SETTINGS, snapshot: fixtureSnapshot(), phase: 'captcha', lineChanged: false }} now={new Date('2026-10-17T08:50:00Z')} api={api} />);
  await userEvent.click(screen.getByRole('button', { name: 'Пройти перевірку' })); expect(api.solveCaptcha).toHaveBeenCalled();
});

const NOW = new Date('2026-10-17T10:30:00Z');
const actualState = (history: ActualSegment[], power: ActualPower = 'on', now = NOW): AppState => ({
  settings: DEFAULT_SETTINGS, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false,
  actual: { sourceLabel: 'EcoFlow', power, observedAt: new Date(now.getTime() - 60_000).toISOString(), history },
});
const HISTORY: ActualSegment[] = [
  { power: 'on', start: '2026-10-15T20:00:00Z', end: '2026-10-16T09:00:00Z' },
  { power: 'off', start: '2026-10-16T09:00:00Z', end: '2026-10-16T09:30:00Z' },
  { power: 'on', start: '2026-10-16T09:30:00Z', end: '2026-10-17T09:10:00Z' },
  { power: 'off', start: '2026-10-17T09:10:00Z', end: '2026-10-17T10:00:00Z' },
  { power: 'on', start: '2026-10-17T10:00:00Z', end: '2026-10-17T10:10:00Z' },
  { power: 'unknown', start: '2026-10-17T10:10:00Z', end: '2026-10-17T10:20:00Z' },
  { power: 'on', start: '2026-10-17T10:20:00Z' },
];
const view = (state: AppState, now = NOW) => render(<ScheduleView state={state} now={now} api={{} as RendererApi} />);

test('actual row on the today tab only', async () => {
  const { container } = view(actualState(HISTORY));
  expect(screen.getByText('Фактично')).toBeInTheDocument();
  expect(container.querySelector('[data-actual-part="off"]')).not.toBeNull();
  expect(container.querySelector('[data-actual-part="unknown"]')).not.toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
  expect(screen.queryByText('Фактично')).toBeNull();
  expect(container.querySelector('[data-actual-part]')).toBeNull();
});
test('outage list newest first with exact lines', () => {
  view(actualState(HISTORY));
  expect(screen.getByRole('heading', { name: 'Фактичні відключення' })).toBeInTheDocument();
  const items = screen.getAllByRole('listitem').map(li => li.textContent);
  expect(items).toEqual(['17.10 · 12:10–13:00 · 50 хв', '16.10 · 12:00–12:30 · 30 хв']);
});
test('empty list text', () => {
  view(actualState([{ power: 'on', start: '2026-10-15T20:00:00Z' }]));
  expect(screen.getByText('За останні 7 днів відключень не зафіксовано')).toBeInTheDocument();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});
test('no actual → no row, no list', () => {
  view({ settings: DEFAULT_SETTINGS, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false });
  expect(screen.queryByText('Фактично')).toBeNull();
  expect(screen.queryByText('Фактичні відключення')).toBeNull();
});
test('status follows the actual state', () => {
  const now = new Date('2026-10-17T08:50:00Z');
  const st = actualState([{ power: 'off', start: '2026-10-17T08:00:00Z' }], 'off', now);
  view(st, now);
  expect(screen.getByRole('heading', { level: 2, name: 'Світла немає' })).toBeInTheDocument();
});
