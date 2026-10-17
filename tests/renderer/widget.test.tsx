// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { Widget } from '../../src/renderer/src/widget/Widget';
import { DayBar } from '../../src/renderer/src/widget/DayBar';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { AppState, WidgetStyle } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const now = new Date('2026-10-17T08:50:00Z');
const st = (p: Partial<AppState> = {}, style: WidgetStyle = 'compact'): AppState =>
  ({ settings: { ...DEFAULT_SETTINGS, widgetStyle: style, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...p });
test.each(['compact', 'ring', 'timeline'] as const)('%s shows status and countdown', style => {
  render(<Widget state={st({}, style)} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
  expect(screen.getByText(style === 'compact' ? 'Вимкнення о 15:00 · через 3 год 10 хв' : '3:10')).toBeInTheDocument();
});
test('compact caption', () => {
  render(<Widget state={st()} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Лінія 1 · черга 1.2 · оновлено 11:48')).toBeInTheDocument();
});
test('timeline: tomorrow not published', () => {
  render(<Widget state={st({}, 'timeline')} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('ще не опубліковано')).toBeInTheDocument(); expect(screen.getByText('Завтра 18.10')).toBeInTheDocument();
});
test('DayBar renders 48 halves with off at 12..16', () => {
  const { container } = render(<DayBar day={fixtureSnapshot().days[0]} />);
  const halves = container.querySelectorAll('[data-slot]'); expect(halves).toHaveLength(48);
  expect(halves[12].getAttribute('data-slot')).toBe('off'); expect(halves[17].getAttribute('data-slot')).toBe('on');
});
test('emergency badge', () => {
  const s = st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення' } }) });
  render(<Widget state={s} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Аварійне')).toBeInTheDocument(); expect(screen.getByText('Світла немає')).toBeInTheDocument();
});
test('stale, line changed, no address', () => {
  const { rerender } = render(<Widget state={st()} now={new Date('2026-10-17T09:40:00Z')} background={{ kind: 'tint' }} />);
  expect(screen.getByText(/дані застаріли/)).toBeInTheDocument();
  rerender(<Widget state={st({ lineChanged: true })} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Схема підключення змінилась — перевірте лінію')).toBeInTheDocument();
  rerender(<Widget state={{ ...st(), settings: DEFAULT_SETTINGS, snapshot: null }} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Налаштуйте адресу')).toBeInTheDocument();
});

test.each(['compact', 'ring', 'timeline'] as const)('%s: overflow protection on long text', style => {
  const stale = new Date('2026-10-17T09:40:00Z');
  const { container, rerender } = render(<Widget state={st({}, style)} now={stale} background={{ kind: 'tint' }} />);
  const cap = container.querySelector('.w-cap')!;
  expect(cap).toHaveAttribute('title', expect.stringContaining('дані застаріли'));
  expect(cap.querySelector('.w-ellipsis')).not.toBeNull();
  expect(cap.querySelector('.w-stale')).toHaveTextContent('дані застаріли');
  rerender(<Widget state={st({ lineChanged: true }, style)} now={now} background={{ kind: 'tint' }} />);
  expect(container.querySelector('.w-cap-warn')).toHaveAttribute('title', 'Схема підключення змінилась — перевірте лінію');
});
test('compact next line is ellipsized with full title', () => {
  const { container } = render(<Widget state={st()} now={now} background={{ kind: 'tint' }} />);
  const next = container.querySelector('.w-next')!;
  expect(next).toHaveClass('w-ellipsis'); expect(next).toHaveAttribute('title', 'Вимкнення о 15:00 · через 3 год 10 хв');
});
test('snapshot null: no caption, no now dot', () => {
  const { container } = render(<Widget state={st({ snapshot: null }, 'ring')} now={now} background={{ kind: 'tint' }} />);
  expect(container.querySelector('.w-cap')).toBeNull(); expect(container.querySelector('circle[r="6"]')).toBeNull();
});
