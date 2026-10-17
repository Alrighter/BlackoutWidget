// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { usePointerGestures } from '../../src/renderer/src/widget/usePointerGestures';

function Harness({ api }: { api: any }) { const h = usePointerGestures(api); return <div data-testid="w" {...h} />; }
const mk = () => ({ widgetDrag: vi.fn(), openMainWindow: vi.fn(), widgetContextMenu: vi.fn() });
test('click opens main window', () => {
  const api = mk(); render(<Harness api={api} />); const w = screen.getByTestId('w');
  fireEvent.pointerDown(w, { button: 0, screenX: 100, screenY: 100, pointerId: 1 }); fireEvent.pointerUp(w, { button: 0, screenX: 101, screenY: 100, pointerId: 1 });
  expect(api.openMainWindow).toHaveBeenCalledWith('schedule'); expect(api.widgetDrag).not.toHaveBeenCalled();
});
test('drag beyond 4px sends start/move/end and no click', () => {
  const api = mk(); render(<Harness api={api} />); const w = screen.getByTestId('w');
  fireEvent.pointerDown(w, { button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  fireEvent.pointerMove(w, { screenX: 110, screenY: 100, pointerId: 1 }); fireEvent.pointerUp(w, { button: 0, screenX: 110, screenY: 100, pointerId: 1 });
  expect(api.widgetDrag.mock.calls.map((c: any[]) => c[0])).toEqual(['start', 'move', 'end']); expect(api.openMainWindow).not.toHaveBeenCalled();
});
test('right click opens context menu', () => {
  const api = mk(); render(<Harness api={api} />); fireEvent.contextMenu(screen.getByTestId('w'));
  expect(api.widgetContextMenu).toHaveBeenCalled();
});
