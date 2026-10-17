// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { WidgetRoot } from '../../src/renderer/src/widget/WidgetRoot';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { AppState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const mk = (p: Partial<AppState> = {}): AppState =>
  ({ settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...p });
const WARN = 'Схема підключення змінилась — перевірте лінію';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('pushed state is kept when the initial getState resolves later', async () => {
  let resolve!: (s: AppState) => void;
  let push!: (s: AppState) => void;
  const api = {
    getState: () => new Promise<AppState>(r => { resolve = r; }),
    onState: (cb: (s: AppState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {},
  } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  act(() => push(mk({ lineChanged: true })));
  expect(screen.getByText(WARN)).toBeInTheDocument();
  await act(async () => { resolve(mk({ lineChanged: false })); });
  expect(screen.getByText(WARN)).toBeInTheDocument();
});

test('getState failure is retried', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const getState = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(mk());
  const api = { getState, onState: () => () => {}, onBackground: () => () => {} } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(getState).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
});
