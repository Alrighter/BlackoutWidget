// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { Widget } from '../../src/renderer/src/widget/Widget';
import { DayBar, dayCells } from '../../src/renderer/src/widget/DayBar';
import { actualGradient, ringGradient, segmentPaint } from '../../src/renderer/src/widget/RingWidget';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { ActualStatus, AppState, Slot, WidgetStyle } from '../../src/shared/types';
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
  // Compact and ring give the warning a row of its own above the caption (mockup); timeline keeps it in the footer.
  if (style === 'timeline') expect(container.querySelector('.w-foot')).toHaveClass('w-foot-changed');
  else expect(container.querySelector('.w-foot .w-cap-warn')).toBeNull();
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
test('DayBar dims the past cells and marks now (11:50 → 23 cells past)', () => {
  const { container } = render(<DayBar day={fixtureSnapshot().days[0]} nowFraction={710 / 1440} />);
  const cells = [...container.querySelectorAll('[data-slot]')];
  cells.forEach((c, i) => {
    if (i <= 22) expect(c).toHaveClass('bw-cell--past'); else expect(c).not.toHaveClass('bw-cell--past');
  });
  expect(parseFloat((container.querySelector('.w-now') as HTMLElement).style.left)).toBeCloseTo(49.31, 1);
});
test('dayCells: the 13:30–17:00 emergency window marks cells 27–33; the planned run after it keeps its own gradient', () => {
  const cells = dayCells(fixtureSnapshot().days[0].slots, undefined, { startMin: 810, endMin: 1020 });
  expect(cells.flatMap((c, i) => (c.emergency ? [i] : []))).toEqual([27, 28, 29, 30, 31, 32, 33]);
  // Fixture off 30..37: 30..33 are emergency (solid, no gradient), 34..37 form a run of their own.
  expect(cells.slice(30, 34).every(c => c.offFrom === undefined)).toBe(true);
  expect(cells.slice(34, 38).map(c => [c.offFrom, c.offTo])).toEqual([[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]]);
  expect(cells[12].offFrom).toBe(0); expect(cells[16].offTo).toBe(1); // the morning run is untouched
});
test.each(['compact', 'timeline'] as const)('%s: the emergency outage is painted in the strip, past cells still dimmed', style => {
  const s = st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', start: '13:30 17.10.2026', end: '17:00 17.10.2026' } }) }, style);
  const { container } = render(<Widget state={s} now={new Date('2026-10-17T11:20:00Z')} background={{ kind: 'tint' }} />); // 14:20 Kyiv
  const cells = [...container.querySelectorAll('[data-slot]')];
  expect(cells.flatMap((c, i) => (c.classList.contains('emergency') ? [i] : []))).toEqual([27, 28, 29, 30, 31, 32, 33]);
  expect(cells[27]).toHaveClass('bw-cell--past'); expect(cells[28]).not.toHaveClass('bw-cell--past');
});
test('compact without a snapshot yet: the now marker is at the clock’s Kyiv minute', () => {
  const { container } = render(<Widget state={st({ snapshot: null })} now={now} background={{ kind: 'tint' }} />); // 11:50 Kyiv
  expect(parseFloat((container.querySelector('.w-now') as HTMLElement).style.left)).toBeCloseTo((710 / 1440) * 100, 2);
});
test('DayBar without now (tomorrow) dims nothing and has no marker', () => {
  const { container } = render(<DayBar day={fixtureSnapshot().days[0]} />);
  expect(container.querySelector('.bw-cell--past, .w-now')).toBeNull();
});
test('DayBar: an off run is one gradient off-a → off-b along its length', () => {
  const day = { ...fixtureSnapshot().days[0], slots: fixtureSnapshot().days[0].slots.map((s, i) => (i === 40 ? 'off' : s === 'off' ? 'off' : 'on')) };
  const { container } = render(<DayBar day={day} />);
  const cells = [...container.querySelectorAll<HTMLElement>('[data-slot]')];
  const stops = (i: number) => [cells[i].style.getPropertyValue('--off-from'), cells[i].style.getPropertyValue('--off-to')];
  // Fixture run 12..16 (5 cells): each cell continues where the previous one stopped.
  expect([12, 13, 14, 15, 16].map(stops)).toEqual([['0%', '20%'], ['20%', '40%'], ['40%', '60%'], ['60%', '80%'], ['80%', '100%']]);
  expect(stops(40)).toEqual(['0%', '100%']); // a one-cell run spans the whole gradient
  expect(stops(17)).toEqual(['', '']); // «on» has none
});
test('compact: no schedule today → 48 hatched unknown cells, not the «ще не опубліковано» bar', () => {
  const { container } = render(<Widget state={st({ snapshot: fixtureSnapshot({ extraDays: [] }) })} now={new Date('2026-10-19T08:50:00Z')} background={{ kind: 'tint' }} />);
  const cells = container.querySelectorAll('[data-slot]');
  expect(cells).toHaveLength(48);
  expect([...cells].every(c => c.getAttribute('data-slot') === 'unknown')).toBe(true);
  expect(screen.queryByText('ще не опубліковано')).toBeNull();
});
test.each([
  ['on', st()],
  ['emergency', st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення' } }) })],
  ['unknown', { ...st(), settings: DEFAULT_SETTINGS, snapshot: null }],
] as const)('card is tinted by the state: %s', (tone, state) => {
  const { container } = render(<Widget state={state} now={now} background={{ kind: 'tint' }} />);
  expect(container.querySelector('.w-card')).toHaveClass(`w-tone-${tone}`);
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
  if (style === 'compact') expect(container.querySelector('.w-cap-warn .w-ellipsis')).toHaveTextContent('Схема підключення змінилась — перевірте лінію');
});
test('compact next line is ellipsized with full title', () => {
  const { container } = render(<Widget state={st()} now={now} background={{ kind: 'tint' }} />);
  const next = container.querySelector('.w-next')!;
  expect(next).toHaveClass('w-ellipsis'); expect(next).toHaveAttribute('title', 'Вимкнення о 15:00 · через 3 год 10 хв');
});
test('snapshot null: no caption, no now dot', () => {
  const { container } = render(<Widget state={st({ snapshot: null }, 'ring')} now={now} background={{ kind: 'tint' }} />);
  expect(container.querySelector('.w-cap')).toBeNull(); expect(container.querySelector('.w-dial-now')).toBeNull();
});

describe('ring', () => {
  const bg = { kind: 'tint' } as const;
  const emergencyAt1420 = () => {
    const s = st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', start: '13:30 17.10.2026', end: '17:00 17.10.2026' } }) }, 'ring');
    return render(<Widget state={s} now={new Date('2026-10-17T11:20:00Z')} background={bg} />); // 14:20 Kyiv
  };
  /** Top-level stops of a CSS gradient (commas inside colour functions don't split). */
  const stopsOf = (g: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '';
    for (const ch of g.slice(g.indexOf('(') + 1, -1)) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    return [...out, cur.trim()];
  };
  const on = (): Slot[] => Array(48).fill('on');

  test('segmentPaint: on solid, off on its run gradient, maybe and unknown hatched, past at 0.4', () => {
    const [cOn, cOff] = dayCells(['on', 'off', 'off', 'off', 'off', 'off', ...on().slice(6)]);
    expect(segmentPaint(cOn)).toEqual({ stripes: false, c0: 'var(--bw-on)', c1: 'var(--bw-on)' });
    expect(segmentPaint(cOff)).toEqual({ stripes: false,
      c0: 'color-mix(in srgb, var(--bw-off-a), var(--bw-off-b) 0%)', c1: 'color-mix(in srgb, var(--bw-off-a), var(--bw-off-b) 20%)' });
    const past = dayCells(['maybe-off', 'unknown', 'off', ...on().slice(3)], 120);
    expect(segmentPaint(past[0])).toEqual({ stripes: true, c0: 'rgb(from var(--bw-maybe) r g b / 0.4)', c1: 'rgb(from var(--bw-maybe) r g b / 0.112)' });
    expect(segmentPaint(past[1])).toEqual({ stripes: true, c0: 'rgb(from var(--bw-unknown) r g b / 0.34)', c1: 'rgb(from var(--bw-unknown) r g b / 0.088)' });
    expect(segmentPaint(past[2]).c0).toBe('rgb(from color-mix(in srgb, var(--bw-off-a), var(--bw-off-b) 0%) r g b / 0.4)');
    expect(segmentPaint(dayCells(null)[0])).toEqual({ stripes: true, c0: 'rgb(from var(--bw-unknown) r g b / 0.85)', c1: 'rgb(from var(--bw-unknown) r g b / 0.22)' });
  });
  test('ringGradient: 48 half hours of 7.5° from 00 clockwise, 0.7° empty at each end, hatches in four bands', () => {
    const stops = stopsOf(ringGradient(dayCells(on())));
    expect(stops).toHaveLength(48 * 4);
    expect(stops.slice(0, 5)).toEqual(['transparent 0deg 0.7deg', 'var(--bw-on) 0.7deg', 'var(--bw-on) 6.8deg', 'transparent 6.8deg 7.5deg', 'transparent 7.5deg 8.2deg']);
    expect(stops.at(-1)).toBe('transparent 359.3deg 360deg');
    const hatched = stopsOf(ringGradient(dayCells(['on', 'maybe-off', ...on().slice(2)])));
    expect(hatched).toHaveLength(48 * 4 + 2);
    const bands = hatched.slice(5, 9);
    expect(bands.map(b => b.replace(/ [\d.]+deg [\d.]+deg$/, ''))).toEqual(
      ['var(--bw-maybe)', 'rgb(from var(--bw-maybe) r g b / 0.28)', 'var(--bw-maybe)', 'rgb(from var(--bw-maybe) r g b / 0.28)']);
    expect(bands[0]).toMatch(/ 8\.2deg [\d.]+deg$/); expect(bands[3]).toMatch(/ 14\.3deg$/);
  });
  test('the segments come from dayCells: the emergency window red, past half hours dimmed', () => {
    const { container } = emergencyAt1420();
    const cells = dayCells(fixtureSnapshot().days[0].slots, 860, { startMin: 810, endMin: 1020 });
    expect(segmentPaint(cells[27]).c0).toBe('rgb(from var(--bw-emergency) r g b / 0.4)'); // 13:30, over
    expect(segmentPaint(cells[28]).c0).toBe('var(--bw-emergency)');
    expect((container.querySelector('.w-dial-segs') as HTMLElement).style.getPropertyValue('--w-segs')).toBe(ringGradient(cells));
  });
  test('the now dot sits on the ring at the clock’s angle; the ring shrinks under the line-changed warning', () => {
    const { container, rerender } = render(<Widget state={st({}, 'ring')} now={now} background={bg} />); // 11:50 = 177.5°
    const dial = () => container.querySelector('.w-dial') as HTMLElement;
    const dot = () => container.querySelector('.w-dial-now') as HTMLElement;
    expect([dial().style.width, dial().style.height]).toEqual(['208px', '208px']);
    expect([dot().style.left, dot().style.top]).toEqual(['108.3px', '201.9px']); // 104 + 98·sin, 104 − 98·cos
    expect(dial()).not.toHaveClass('w-dial-small');
    rerender(<Widget state={st({ lineChanged: true }, 'ring')} now={now} background={bg} />);
    expect(dial().style.width).toBe('184px');
    expect(dial()).toHaveClass('w-dial-small'); // narrower centre text, clear of the 18 / 06 ticks
    expect([dot().style.left, dot().style.top]).toEqual(['95.8px', '177.9px']); // 92 ± 86
  });
  test('a six-character countdown («≈17:40») is marked long, so the small ring can set it smaller', () => {
    const outage = { kind: 'emergency' as const, text: 'Аварійне відключення', start: '13:30 17.10.2026', end: '08:00 18.10.2026' };
    const { container } = render(<Widget state={st({ snapshot: fixtureSnapshot({ currentOutage: outage }) }, 'ring')} now={new Date('2026-10-17T11:20:00Z')} background={bg} />);
    expect(container.querySelector('.w-dial-count')).toHaveTextContent(/^≈17:40$/);
    expect(container.querySelector('.w-dial-count')).toHaveClass('w-dial-count-long');
    const plain = render(<Widget state={st({}, 'ring')} now={now} background={bg} />);
    expect(plain.container.querySelector('.w-dial-count')).not.toHaveClass('w-dial-count-long');
  });
  test('no schedule for today: hatched ring, the now dot still shows the time', () => {
    const { container } = render(<Widget state={st({ snapshot: fixtureSnapshot({ extraDays: [] }) }, 'ring')} now={new Date('2026-10-19T08:50:00Z')} background={bg} />);
    expect((container.querySelector('.w-dial-segs') as HTMLElement).style.getPropertyValue('--w-segs')).toBe(ringGradient(dayCells(null, 710)));
    expect(container.querySelector('.w-dial-now')).not.toBeNull();
    expect(container.querySelector('.w-dial-title')).toHaveTextContent(/^Немає даних$/);
    expect(container.querySelector('.w-dial-cap')).toHaveTextContent(/^графік на сьогодні ще не отримано$/);
  });
  test('count layout: dot + status, big countdown, its caption; 00/06/12/18 around', () => {
    const { container } = render(<Widget state={st({}, 'ring')} now={now} background={bg} />);
    expect(container.querySelector('.w-dial-center .w-status .w-dot')).not.toBeNull();
    expect(container.querySelector('.w-dial-center .w-status .w-title')).toHaveTextContent(/^Світло є$/);
    expect(container.querySelector('.w-dial-count')).toHaveTextContent(/^3:10$/);
    expect(container.querySelector('.w-dial-cap')).toHaveTextContent(/^до вимкнення о 15:00$/);
    expect([...container.querySelectorAll('.w-dial-tick')].map(t => t.textContent)).toEqual(['00', '06', '12', '18']);
  });
  test('emergency: the badge above the status row, «≈» before the countdown', () => {
    const { container } = emergencyAt1420();
    const badge = container.querySelector('.w-dial-center > .w-badge')!;
    expect(badge).toHaveTextContent('Аварійне');
    expect(badge.nextElementSibling).toHaveClass('w-status');
    expect(container.querySelector('.w-status .w-badge')).toBeNull();
    expect(container.querySelector('.w-dial-count')).toHaveTextContent(/^≈2:40$/);
    expect(container.querySelector('.w-dial-cap')).toHaveTextContent(/^до орієнтовного увімкнення$/);
  });
  test('emergency with no known end: no-count layout, the badge between the dot and the status', () => {
    const s = st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення' } }) }, 'ring');
    const { container } = render(<Widget state={s} now={now} background={bg} />);
    expect(container.querySelector('.w-dial-count')).toBeNull();
    expect(container.querySelector('.w-dial-marks + .w-badge + .w-dial-title')).toHaveTextContent(/^Світла немає$/);
    expect(container.querySelector('.w-dial-cap')).toHaveTextContent(/^аварійне відключення · час відновлення невідомий$/);
  });
  test('caption: the full line label and «оновлено»; the warning is a row of its own above it', () => {
    const { container, rerender } = render(<Widget state={st({}, 'ring')} now={now} background={bg} />);
    expect(container.querySelector('.w-cap')).toHaveTextContent('Лінія 1 · черга 1.2 · оновлено 11:48');
    rerender(<Widget state={st({ lineChanged: true }, 'ring')} now={now} background={bg} />);
    expect(container.querySelector('.w-warnline + .w-foot .w-cap')).toHaveTextContent('Лінія 1 · черга 1.2 · оновлено 11:48');
  });
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
    expect(mark).toHaveAttribute('aria-label', 'Фактичний стан · EcoFlow');
    expect(mark).toHaveAttribute('role', 'img');
    expect(mark).not.toHaveAttribute('title'); // no native tooltip over the custom one
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
  test('ring: inner arc for the actual power, off at 12:10–13:00 then on until now (14:00)', () => {
    const { container } = render(<Widget state={st({ actual: withStrip(later) }, 'ring')} now={later} background={bg} />);
    const arcs = container.querySelectorAll<HTMLElement>('[data-actual-arc]');
    expect(arcs).toHaveLength(1);
    // Minutes / 4 = degrees clockwise from 00: 730 → 182.5°, 780 → 195°, 840 → 210°.
    expect(arcs[0].style.getPropertyValue('--w-actual')).toBe('conic-gradient(transparent 0deg 182.5deg, '
      + 'var(--bw-off-dot) 182.5deg 195deg, rgb(from var(--bw-on) r g b / 0.75) 195deg 210deg, transparent 210deg 360deg)');
    expect(container.querySelector('.w-dial-track')).not.toBeNull();
  });
  test('ring: actual unknown is a dashed stretch, 1.5° on / 1.5° off', () => {
    expect(actualGradient([{ startMin: 0, endMin: 18, power: 'unknown' }])).toBe('conic-gradient('
      + 'rgb(from var(--bw-unknown) r g b / 0.95) 0deg 1.5deg, transparent 1.5deg 3deg, '
      + 'rgb(from var(--bw-unknown) r g b / 0.95) 3deg 4.5deg, transparent 4.5deg 360deg)');
  });
  test.each([
    ['matches the schedule: count layout, «з HH:MM» in the status row', new Date('2026-10-17T13:00:00Z'), '.w-dial-center .w-status .w-eco'],
    ['contradicts it: no-count layout, the bolt next to the dot', now, '.w-dial-marks .w-eco'],
  ] as const)('ring: actual %s; the tooltip opens above the bolt', (_, at, bolt) => {
    const { container } = render(<Widget state={st({ actual: act(at) }, 'ring')} now={at} background={bg} />);
    expect(container.querySelector(bolt)).not.toBeNull();
    if (at === now) {
      expect(container.querySelector('.w-since')).toBeNull();
      expect(container.querySelector('.w-dial-cap')).toHaveTextContent(/^не за графіком · з 10:10$/);
    } else {
      expect(container.querySelector('.w-dial-center .w-status .w-since')).toHaveTextContent(/^з 10:10$/);
    }
    fireEvent.pointerEnter(container.querySelector('[data-actual="live"]')!);
    expect(screen.getByRole('tooltip')).toHaveClass('w-tip-above');
  });
  test('compact: the tooltip keeps opening below the bolt', () => {
    const { container } = render(<Widget state={st({ actual: act(now) })} now={now} background={bg} />);
    fireEvent.pointerEnter(container.querySelector('[data-actual="live"]')!);
    expect(screen.getByRole('tooltip')).not.toHaveClass('w-tip-above');
  });
  test('unknown source shows muted mark with reason tooltip', () => {
    const a = act(now, { power: 'unknown', reason: 'станція не в мережі' });
    const { container } = render(<Widget state={st({ actual: a })} now={now} background={bg} />);
    expect(container.querySelector('[data-actual="live"]')).toBeNull();
    expect(container.querySelector('[data-actual="unknown"]')).toHaveAttribute('aria-label', 'EcoFlow: станція не в мережі');
    expect(screen.getByText('Світло є')).toBeInTheDocument();
  });
  test.each(['compact', 'ring', 'timeline'] as const)('%s: no actual configured → no mark, no line', style => {
    const { container } = render(<Widget state={st({}, style)} now={now} background={bg} />);
    expect(container.querySelector('[data-actual], [data-actual-part], [data-actual-arc], .w-actual-line')).toBeNull();
  });
  test('compact: «з HH:MM» sits in the status row when actual matches the schedule', () => {
    const offNow = new Date('2026-10-17T13:00:00Z'); // 16:00 Kyiv, schedule: off
    const { container } = render(<Widget state={st({ actual: act(offNow) })} now={offNow} background={bg} />);
    expect(container.querySelector('.w-status .w-since')).toHaveTextContent(/^з 10:10$/);
    expect(container.querySelector('.w-next')).toHaveTextContent(/^Увімкнуть о 19:00 · через 3 год$/);
    // On a mismatch the next line carries it, and the status row doesn't repeat it.
    const mm = render(<Widget state={st({ actual: act(now) })} now={now} background={bg} />);
    expect(mm.container.querySelector('.w-next')).toHaveTextContent(/^Не за графіком · з 10:10$/);
    expect(mm.container.querySelector('.w-since')).toBeNull();
  });
  test.each([
    ['live', act(now), 'Фактичний стан · EcoFlow'],
    ['unknown', act(now, { power: 'unknown', reason: 'станція не в мережі' }), 'EcoFlow: станція не в мережі'],
  ] as const)('compact: the %s bolt shows its tooltip on hover and on focus', (kind, actual, text) => {
    const { container } = render(<Widget state={st({ actual })} now={now} background={bg} />);
    const bolt = container.querySelector(`[data-actual="${kind}"]`) as HTMLElement;
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(bolt);
    expect(screen.getByRole('tooltip')).toHaveTextContent(text);
    fireEvent.pointerLeave(bolt);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(bolt);
    expect(screen.getByRole('tooltip')).toHaveTextContent(text);
    fireEvent.blur(bolt);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(bolt).toHaveAttribute('tabindex', '0');
    expect(fireEvent.mouseDown(bolt)).toBe(false); // a press doesn't focus it (and so doesn't pin the tooltip open)
  });
  test('compact: the actual line sits inside the strip, under the cells', () => {
    const { container } = render(<Widget state={st({ actual: withStrip(later) })} now={later} background={bg} />);
    expect(container.querySelector('.w-strip > .w-cells + .w-actual-line')).not.toBeNull();
    expect(container.querySelector('.w-strip > .w-now')).not.toBeNull();
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
