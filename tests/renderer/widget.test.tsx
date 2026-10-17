// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { Widget } from '../../src/renderer/src/widget/Widget';
import { DayBar } from '../../src/renderer/src/widget/DayBar';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { ActualStatus, AppState, WidgetStyle } from '../../src/shared/types';
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
  const { container } = render(<Widget state={st()} now={now} background={{ kind: 'tint' }} />);
  expect(container.querySelector('.w-cap')).toHaveTextContent('Лінія 1 · черга 1.2 · оновлено 11:48');
  expect(container.querySelector('.w-cap')).toHaveAttribute('title', 'Лінія 1 · черга 1.2 · оновлено 11:48');
});
test.each(['compact', 'ring', 'timeline'] as const)('%s: line changed + stale keeps the updated time and the stale mark next to the warning', style => {
  const { container } = render(<Widget state={st({ lineChanged: true }, style)} now={new Date('2026-10-17T09:40:00Z')} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Схема підключення змінилась — перевірте лінію')).toBeInTheDocument();
  expect(screen.getByText(/оновлено 11:48/i)).toHaveClass('w-fixed');
  expect(screen.getByText('дані застаріли')).toHaveClass('w-stale');
  expect(container.querySelector('.w-foot')).toHaveClass('w-foot-changed');
});
test.each(['compact', 'ring', 'timeline'] as const)('%s: the updated time never sits in the shrinking part', style => {
  const { container } = render(<Widget state={st({}, style)} now={new Date('2026-10-17T09:40:00Z')} background={{ kind: 'tint' }} />);
  const cap = container.querySelector('.w-cap')!;
  expect(cap.querySelector('.w-fixed')).toHaveTextContent(/^оновлено 11:48$/i);
  expect(cap.querySelector('.w-ellipsis')?.textContent ?? '').not.toMatch(/оновлено/i);
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
  if (style !== 'timeline') expect(cap.querySelector('.w-ellipsis')).not.toBeNull(); // timeline has no label here
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

describe('actual state', () => {
  const bg = { kind: 'tint' } as const;
  const act = (n: Date, over: Partial<ActualStatus> = {}): ActualStatus => ({
    sourceLabel: 'EcoFlow', power: 'off', since: '2026-10-17T07:10:00Z',
    observedAt: new Date(n.getTime() - 30_000).toISOString(),
    history: [{ power: 'off', start: '2026-10-17T07:10:00Z' }], ...over,
  });
  const later = new Date('2026-10-17T11:00:00Z'); // 14:00 Kyiv
  const withStrip = (n: Date) => act(n, {
    power: 'on', since: '2026-10-17T10:00:00Z',
    history: [{ power: 'off', start: '2026-10-17T09:10:00Z', end: '2026-10-17T10:00:00Z' }, { power: 'on', start: '2026-10-17T10:00:00Z' }],
  });

  test.each(['compact', 'ring', 'timeline'] as const)('%s: live source mark and actual title', style => {
    const { container } = render(<Widget state={st({ actual: act(now) }, style)} now={now} background={bg} />);
    expect(screen.getByText('Світла немає')).toBeInTheDocument();
    const mark = container.querySelector('[data-actual="live"]')!;
    expect(mark).toHaveTextContent(style === 'ring' ? 'Фактичний стан · EcoFlow' : '');
    if (style !== 'ring') expect(mark).toHaveAttribute('title', 'Фактичний стан · EcoFlow');
  });
  test.each(['compact', 'timeline'] as const)('%s: actual line parts rendered for today', style => {
    const { container } = render(<Widget state={st({ actual: withStrip(later) }, style)} now={later} background={bg} />);
    const off = container.querySelector('[data-actual-part="off"]') as HTMLElement;
    expect(off).not.toBeNull();
    expect(parseFloat(off.style.left)).toBeCloseTo(50.69, 1);
    expect(parseFloat(off.style.width)).toBeCloseTo(3.47, 1);
    expect(container.querySelectorAll('[data-actual-part]')).toHaveLength(2);
  });
  test('timeline: the actual line is only under today', () => {
    const { container } = render(<Widget state={st({ actual: withStrip(later) }, 'timeline')} now={later} background={bg} />);
    expect(container.querySelectorAll('.w-actual-line')).toHaveLength(1);
  });
  test('ring: inner arc for actual off', () => {
    const { container } = render(<Widget state={st({ actual: withStrip(later) }, 'ring')} now={later} background={bg} />);
    const arcs = container.querySelectorAll('[data-actual-arc]');
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toHaveAttribute('r', '68');
  });
  test('unknown source shows muted mark with reason tooltip', () => {
    const a = act(now, { power: 'unknown', reason: 'станція не в мережі' });
    const { container } = render(<Widget state={st({ actual: a })} now={now} background={bg} />);
    expect(container.querySelector('[data-actual="live"]')).toBeNull();
    expect(container.querySelector('[data-actual="unknown"]')).toHaveAttribute('title', 'EcoFlow: станція не в мережі');
    expect(screen.getByText('Світло є')).toBeInTheDocument();
  });
  test.each(['compact', 'ring', 'timeline'] as const)('%s: no actual configured → no mark, no line', style => {
    const { container } = render(<Widget state={st({}, style)} now={now} background={bg} />);
    expect(container.querySelector('[data-actual], [data-actual-part], [data-actual-arc], .w-actual-line')).toBeNull();
  });
  test('compact: «з HH:MM» sits in the next line when actual matches the schedule', () => {
    const offNow = new Date('2026-10-17T13:00:00Z'); // 16:00 Kyiv, schedule: off
    const { container } = render(<Widget state={st({ actual: act(offNow) })} now={offNow} background={bg} />);
    expect(container.querySelector('.w-next')).toHaveTextContent('Увімкнуть о 19:00 · через 3 год · з 10:10');
    const mm = render(<Widget state={st({ actual: act(now) })} now={now} background={bg} />);
    expect(mm.container.querySelector('.w-next')).toHaveTextContent(/^Не за графіком · з 10:10$/);
  });
  test('timeline: «з HH:MM» under the status when actual matches', () => {
    const offNow = new Date('2026-10-17T13:00:00Z');
    const { container } = render(<Widget state={st({ actual: act(offNow) }, 'timeline')} now={offNow} background={bg} />);
    expect(container.querySelector('.w-tl-sub')).toHaveTextContent('з 10:10');
  });
  test.each(['compact', 'ring', 'timeline'] as const)('%s: mismatch text fits — caption with «оновлено» still present', style => {
    const { container } = render(<Widget state={st({ actual: act(now), lineChanged: true }, style)} now={now} background={bg} />);
    expect(container.querySelector('.w-cap .w-fixed')).toHaveTextContent(/^оновлено 11:48$/i);
  });
});
