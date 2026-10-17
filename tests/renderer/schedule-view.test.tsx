// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleView } from '../../src/renderer/src/app/ScheduleView';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { AppState } from '../../src/shared/types';
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
