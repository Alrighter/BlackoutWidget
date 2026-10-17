// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WidgetRoot } from '../../src/renderer/src/widget/WidgetRoot';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { AppState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const mk = (p: Partial<AppState> = {}): AppState =>
  ({ settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...p });
const WARN = 'Схема підключення змінилась — перевірте лінію';

// The fixture is for 2026-10-17: pin the clock to 11:50 Kyiv («Світло є» until 15:00) so results don't depend on the wall clock.
const T0 = new Date('2026-10-17T08:50:00Z');
const pinDate = (d = T0) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(d); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('pushed state is kept when the initial getState resolves later', async () => {
  let resolve!: (s: AppState) => void;
  let push!: (s: AppState) => void;
  const api = {
    getState: () => new Promise<AppState>(r => { resolve = r; }),
    onState: (cb: (s: AppState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {},
    onMoveMode: () => () => {},
  } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  act(() => push(mk({ lineChanged: true })));
  expect(screen.getByText(WARN)).toBeInTheDocument();
  await act(async () => { resolve(mk({ lineChanged: false })); });
  expect(screen.getByText(WARN)).toBeInTheDocument();
});

test('getState failure is retried', async () => {
  vi.useFakeTimers({ now: T0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const getState = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(mk());
  const api = { getState, onState: () => () => {}, onBackground: () => () => {}, onMoveMode: () => () => {} } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(getState).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
});

test('move mode shows «Готово»; pressing it ends move mode without opening the main window', async () => {
  let setMoving!: (on: boolean) => void;
  const api = {
    getState: () => Promise.resolve(mk()), onState: () => () => {}, onBackground: () => () => {},
    onMoveMode: (cb: (on: boolean) => void) => { setMoving = cb; return () => {}; },
    endMoveMode: vi.fn(), openMainWindow: vi.fn(), widgetDrag: vi.fn(), widgetContextMenu: vi.fn(),
  };
  pinDate();
  render(<WidgetRoot api={api as unknown as RendererApi} />);
  await screen.findByText('Світло є');
  expect(screen.queryByText('Готово')).toBeNull();
  act(() => setMoving(true));
  const done = screen.getByRole('button', { name: 'Готово' });
  fireEvent.pointerDown(done, { button: 0, screenX: 10, screenY: 10, pointerId: 1 });
  fireEvent.pointerUp(done, { button: 0, screenX: 10, screenY: 10, pointerId: 1 });
  fireEvent.click(done);
  expect(api.endMoveMode).toHaveBeenCalledTimes(1);
  expect(api.openMainWindow).not.toHaveBeenCalled();
  act(() => setMoving(false));
  expect(screen.queryByText('Готово')).toBeNull();
});

test('a pushed state also refreshes the clock', async () => {
  pinDate();
  let push!: (s: AppState) => void;
  const api = {
    getState: () => Promise.resolve(mk()), onState: (cb: (s: AppState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {}, onMoveMode: () => () => {},
  } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  expect(await screen.findByText('Вимкнення о 15:00 · через 3 год 10 хв')).toBeInTheDocument();
  vi.setSystemTime(new Date('2026-10-17T08:55:30Z')); // 11:55:30 Kyiv, before the next minute tick
  act(() => push(mk()));
  expect(screen.getByText('Вимкнення о 15:00 · через 3 год 5 хв')).toBeInTheDocument();
});
