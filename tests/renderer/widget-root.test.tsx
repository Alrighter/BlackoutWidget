// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WidgetRoot } from '../../src/renderer/src/widget/WidgetRoot';
import type { RendererApi } from '../../src/shared/ipc';
import type { WidgetState, WidgetStyle } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const mk = (p: Partial<WidgetState['location']> = {}, style: WidgetStyle = 'compact'): WidgetState => ({
  showName: false,
  location: {
    location: { id: 'loc-1', name: 'Дім', address: fixtureSnapshot().address, widgetStyle: style, widgetPosition: null },
    snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...p,
  },
});
const WARN = 'Схема підключення змінилась — перевірте лінію';

// The fixture is for 2026-10-17: pin the clock to 11:50 Kyiv («Світло є» until 15:00) so results don't depend on the wall clock.
const T0 = new Date('2026-10-17T08:50:00Z');
const pinDate = (d = T0) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(d); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('pushed state is kept when the initial getWidgetState resolves later', async () => {
  let resolve!: (s: WidgetState) => void;
  let push!: (s: WidgetState) => void;
  const api = {
    getWidgetState: () => new Promise<WidgetState>(r => { resolve = r; }),
    onWidgetState: (cb: (s: WidgetState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {},
    onMoveMode: () => () => {},
  } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  act(() => push(mk({ lineChanged: true })));
  expect(screen.getByText(WARN)).toBeInTheDocument();
  await act(async () => { resolve(mk({ lineChanged: false })); });
  expect(screen.getByText(WARN)).toBeInTheDocument();
});

test('getWidgetState failure is retried', async () => {
  vi.useFakeTimers({ now: T0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const getWidgetState = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(mk());
  const api = { getWidgetState, onWidgetState: () => () => {}, onBackground: () => () => {}, onMoveMode: () => () => {} } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(getWidgetState).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
});

test('move mode shows «Готово»; pressing it ends move mode without opening the main window', async () => {
  let setMoving!: (on: boolean) => void;
  const api = {
    getWidgetState: () => Promise.resolve(mk()), onWidgetState: () => () => {}, onBackground: () => () => {},
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

test('move mode draws the frame, the move glyph and the hint pill inside the card, for every style', async () => {
  let setMoving!: (on: boolean) => void;
  let push!: (s: WidgetState) => void;
  const api = {
    getWidgetState: () => Promise.resolve(mk()), onWidgetState: (cb: (s: WidgetState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {}, onMoveMode: (cb: (on: boolean) => void) => { setMoving = cb; return () => {}; },
  } as unknown as RendererApi;
  pinDate();
  const { container } = render(<WidgetRoot api={api} />);
  await screen.findByText('Світло є');
  expect(screen.queryByText('Перетягніть віджет у потрібне місце')).toBeNull();
  act(() => setMoving(true));
  for (const style of ['compact', 'ring', 'timeline'] as const) {
    act(() => push(mk({}, style)));
    const card = container.querySelector(`.w-card.w-${style}`)!;
    const pill = screen.getByText('Перетягніть віджет у потрібне місце').closest('.w-move-pill')!;
    expect(card.contains(pill)).toBe(true);
    expect(pill).toContainElement(screen.getByRole('button', { name: 'Готово' }));
    expect(card.querySelector('.w-move-frame')).toHaveAttribute('aria-hidden', 'true');
    expect(card.querySelector('.w-move-glyph')).toHaveAttribute('aria-hidden', 'true');
  }
  act(() => setMoving(false));
  expect(screen.queryByText('Перетягніть віджет у потрібне місце')).toBeNull();
  expect(container.querySelector('.w-move-frame, .w-move-glyph')).toBeNull();
});

test('in move mode a press on the hint pill still drags the widget', async () => {
  let setMoving!: (on: boolean) => void;
  const api = {
    getWidgetState: () => Promise.resolve(mk()), onWidgetState: () => () => {}, onBackground: () => () => {},
    onMoveMode: (cb: (on: boolean) => void) => { setMoving = cb; return () => {}; },
    endMoveMode: vi.fn(), openMainWindow: vi.fn(), widgetDrag: vi.fn(), widgetContextMenu: vi.fn(),
  };
  pinDate();
  render(<WidgetRoot api={api as unknown as RendererApi} />);
  await screen.findByText('Світло є');
  act(() => setMoving(true));
  const hint = screen.getByText('Перетягніть віджет у потрібне місце');
  fireEvent.pointerDown(hint, { button: 0, screenX: 100, screenY: 100, pointerId: 2 });
  fireEvent.pointerMove(hint, { screenX: 130, screenY: 90, pointerId: 2 });
  fireEvent.pointerUp(hint, { button: 0, screenX: 130, screenY: 90, pointerId: 2 });
  expect(api.widgetDrag.mock.calls).toEqual([['start', 100, 100], ['move', 130, 90], ['end', 130, 90]]);
  expect(api.openMainWindow).not.toHaveBeenCalled();
  expect(api.endMoveMode).not.toHaveBeenCalled();
});

test('a pushed state also refreshes the clock', async () => {
  pinDate();
  let push!: (s: WidgetState) => void;
  const api = {
    getWidgetState: () => Promise.resolve(mk()), onWidgetState: (cb: (s: WidgetState) => void) => { push = cb; return () => {}; },
    onBackground: () => () => {}, onMoveMode: () => () => {},
  } as unknown as RendererApi;
  render(<WidgetRoot api={api} />);
  expect(await screen.findByText('Вимкнення о 15:00 · через 3 год 10 хв')).toBeInTheDocument();
  vi.setSystemTime(new Date('2026-10-17T08:55:30Z')); // 11:55:30 Kyiv, before the next minute tick
  act(() => push(mk()));
  expect(screen.getByText('Вимкнення о 15:00 · через 3 год 5 хв')).toBeInTheDocument();
});

test('a null answer (main does not know this window yet) is retried, never rendered', async () => {
  vi.useFakeTimers({ now: T0 });
  const getWidgetState = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(mk());
  const api = { getWidgetState, onWidgetState: () => () => {}, onBackground: () => () => {}, onMoveMode: () => () => {} } as unknown as RendererApi;
  const { container } = render(<WidgetRoot api={api} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(container.querySelector('.w-card')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(getWidgetState).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
});
