// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleView } from '../../src/renderer/src/app/ScheduleView';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { ActualPower, ActualSegment, ActualSourceConfig, ActualStatus, Location, LocationState, Settings } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

const noop = () => {};
const HOME: Location = { id: 'home', name: 'Дім', address: fixtureSnapshot().address, widgetStyle: 'compact', widgetPosition: null };
const PARENTS: Location = { id: 'b', name: 'Батьки', address: { ...fixtureSnapshot().address, house: '12' }, widgetStyle: 'ring', widgetPosition: null };
const locOf = (over: Partial<LocationState> = {}): LocationState => ({ location: HOME, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...over });
/** EcoFlow stands at «Дім» unless a test says otherwise. */
const settingsOf = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, locations: [HOME, PARENTS], actualLocationId: 'home', ...over });

const NOW = new Date('2026-10-17T10:30:00Z');
function view(loc: LocationState, opts: { now?: Date; settings?: Settings; api?: RendererApi; onConnectEcoflow?: () => void; onChangeAddress?: () => void } = {}) {
  const { now = NOW, settings = settingsOf(), api = {} as RendererApi, onConnectEcoflow = noop, onChangeAddress = noop } = opts;
  return render(<ScheduleView loc={loc} settings={settings} now={now} api={api} onConnectEcoflow={onConnectEcoflow} onChangeAddress={onChangeAddress} />);
}

test('shows source time and unpublished tomorrow', async () => {
  view(locOf(), { now: new Date('2026-10-17T08:50:00Z') });
  expect(screen.getByText('Оновлено о 11:48 · графік ДТЕК від 17.10.2026 11:55')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
  expect(screen.getByText('Графік на завтра ще не опубліковано')).toBeInTheDocument();
});
test('the day tabs are a labelled tablist; the hour row over the grid is decorative', () => {
  const { container } = view(locOf(), { now: new Date('2026-10-17T08:50:00Z') });
  const days = screen.getByRole('tablist', { name: 'День' });
  expect(within(days).getAllByRole('tab').map(t => t.textContent)).toEqual(['Сьогодні 17.10', 'Завтра 18.10']);
  expect(container.querySelector('.sv-hours')).toHaveAttribute('aria-hidden', 'true');
});
test('captcha banner calls solveCaptcha', async () => {
  const api = { solveCaptcha: vi.fn(async () => {}) } as unknown as RendererApi;
  view(locOf({ phase: 'captcha' }), { now: new Date('2026-10-17T08:50:00Z'), api });
  expect(screen.getByText('Сайт ДТЕК просить пройти перевірку')).toBeInTheDocument();
  expect(screen.getByText('Поки її не пройдено, графік не оновлюється.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Пройти перевірку' })); expect(api.solveCaptcha).toHaveBeenCalledWith('dtek-krem');
});
test('captcha action solves this location\'s provider', async () => {
  const api = { solveCaptcha: vi.fn(async () => {}) } as unknown as RendererApi;
  const volyn: Location = { ...PARENTS, address: { ...PARENTS.address, providerId: 'voe' } };
  view(locOf({ location: volyn, snapshot: null, phase: 'captcha' }), { api });
  await userEvent.click(screen.getByRole('button', { name: 'Пройти перевірку' }));
  expect(api.solveCaptcha).toHaveBeenCalledTimes(1);
  expect(api.solveCaptcha).toHaveBeenCalledWith('voe');
});
test('a Volyn snapshot names its provider in the banner and the foot', () => {
  const base = fixtureSnapshot({ fetchedAt: '2026-10-17T11:15:00.000Z', sourceUpdatedAt: '22:26 19.10.2026', currentOutage: { kind: 'emergency', text: 'Аварійний випадок в мережах', start: '13:30 17.10.2026', end: '17:00 17.10.2026' } });
  const snapshot = { ...base, providerId: 'voe', address: { ...base.address, providerId: 'voe' } };
  view(locOf({ snapshot }), { now: new Date('2026-10-17T11:20:00Z') });
  expect(screen.getByText('Волиньобленерго: «Аварійний випадок в мережах»')).toBeInTheDocument();
  expect(screen.getByText(/· графік Волиньобленерго від 22:26 19\.10\.2026$/)).toBeInTheDocument();
});
test('the line-changed banner\'s Змінити адресу calls onChangeAddress', async () => {
  const api = { openMainWindow: vi.fn() } as unknown as RendererApi;
  const onChangeAddress = vi.fn();
  view(locOf({ lineChanged: true }), { now: new Date('2026-10-17T08:50:00Z'), api, onChangeAddress });
  expect(screen.getByText('Схема підключення змінилась — перевірте лінію')).toBeInTheDocument();
  expect(screen.getByText('Графік для вашої адреси тепер може бути іншим.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу' }));
  expect(onChangeAddress).toHaveBeenCalledTimes(1);
  expect(api.openMainWindow).not.toHaveBeenCalled();
});

const actualOf = (history: ActualSegment[], power: ActualPower = 'on', now = NOW): ActualStatus =>
  ({ sourceLabel: 'EcoFlow', power, observedAt: new Date(now.getTime() - 60_000).toISOString(), history });
const actualLoc = (history: ActualSegment[], power: ActualPower = 'on', now = NOW): LocationState => locOf({ actual: actualOf(history, power, now) });
const HISTORY: ActualSegment[] = [
  { power: 'on', start: '2026-10-15T20:00:00Z', end: '2026-10-16T09:00:00Z' },
  { power: 'off', start: '2026-10-16T09:00:00Z', end: '2026-10-16T09:30:00Z' },
  { power: 'on', start: '2026-10-16T09:30:00Z', end: '2026-10-17T09:10:00Z' },
  { power: 'off', start: '2026-10-17T09:10:00Z', end: '2026-10-17T10:00:00Z' },
  { power: 'on', start: '2026-10-17T10:00:00Z', end: '2026-10-17T10:10:00Z' },
  { power: 'unknown', start: '2026-10-17T10:10:00Z', end: '2026-10-17T10:20:00Z' },
  { power: 'on', start: '2026-10-17T10:20:00Z' },
];
const SOURCE: ActualSourceConfig = { id: 'ecoflow', region: 'eu', deviceSn: 'R331ZEB4ZEA00142', deviceName: 'Delta 2', accessKeyHint: 'Fp4S…' };

test('actual row: today\'s parts on the today tab; tomorrow shows none, only a placeholder', async () => {
  const { container } = view(actualLoc(HISTORY), { settings: settingsOf({ actualSource: SOURCE }) });
  expect(screen.getByText('Фактично')).toBeInTheDocument();
  expect(container.querySelector('[data-actual-part="off"]')).not.toBeNull();
  expect(container.querySelector('[data-actual-part="unknown"]')).not.toBeNull();
  const off = container.querySelector<HTMLElement>('[data-actual-part="off"]')!;
  expect(parseFloat(off.style.left)).toBeCloseTo((730 / 1440) * 100, 3);
  expect(parseFloat(off.style.width)).toBeCloseTo((50 / 1440) * 100, 3);
  await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
  expect(container.querySelector('[data-actual-part]')).toBeNull();
  expect(screen.getByText('з’явиться, коли настане день')).toBeInTheDocument();
});
test('outage list newest first with exact lines', () => {
  view(actualLoc(HISTORY));
  expect(screen.getByRole('heading', { name: 'Фактичні відключення · 7 днів' })).toBeInTheDocument();
  expect(screen.getByText('за даними EcoFlow')).toBeInTheDocument();
  const items = screen.getAllByRole('listitem').map(li => Array.from(li.children, c => c.textContent).join(' · '));
  expect(items).toEqual(['17.10 · 12:10–13:00 · 50 хв', '16.10 · 12:00–12:30 · 30 хв']);
});
test('an ongoing outage is the live item: «з …» and «триває …»', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  view(actualLoc([{ power: 'on', start: '2026-10-16T20:00:00Z', end: '2026-10-17T08:10:00Z' }, { power: 'off', start: '2026-10-17T08:10:00Z' }], 'off', now), { now });
  const [item] = screen.getAllByRole('listitem');
  expect(Array.from(item.children, c => c.textContent)).toEqual(['17.10', 'з 11:10', 'триває 1 год 50 хв']);
  expect(item).toHaveClass('live');
});
test('empty list text', () => {
  view(actualLoc([{ power: 'on', start: '2026-10-15T20:00:00Z' }]));
  expect(screen.getByText('За останні 7 днів відключень не зафіксовано')).toBeInTheDocument();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});
test('no EcoFlow → the empty state (D10): «Підключити» in the actual row and the «Підключити EcoFlow» card', async () => {
  const onConnect = vi.fn();
  const { container } = view(locOf(), { onConnectEcoflow: onConnect });
  expect(container.querySelector('[data-actual-part]')).toBeNull();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(screen.getByText('Підключіть EcoFlow, щоб бачити, чи є світло насправді')).toBeInTheDocument();
  expect(screen.getByText('Тут будуть реальні відключення')).toBeInTheDocument();
  expect(screen.getByText('Зарядна станція EcoFlow може показувати, чи є світло насправді.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Підключити' }));
  await userEvent.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(onConnect).toHaveBeenCalledTimes(2);
});
test('EcoFlow saved but no status yet → no parts, no list and nothing to connect', () => {
  const { container } = view(locOf({ actual: null }), { settings: settingsOf({ actualSource: SOURCE }) });
  expect(container.querySelector('[data-actual-part]')).toBeNull();
  expect(screen.queryByRole('heading', { name: /Фактичні відключення/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Підключити/ })).toBeNull();
});
test('status follows the actual state', () => {
  const now = new Date('2026-10-17T08:50:00Z');
  view(actualLoc([{ power: 'off', start: '2026-10-17T08:00:00Z' }], 'off', now), { now, settings: settingsOf({ actualSource: SOURCE }) });
  expect(screen.getByRole('heading', { level: 2, name: 'Світла немає' })).toBeInTheDocument();
  expect(screen.getByText('Фактично · EcoFlow')).toBeInTheDocument();
});
test('the countdown with its caption, and the outage line under the grid', () => {
  view(locOf(), { now: new Date('2026-10-17T08:50:00Z') });
  expect(screen.getByText('3:10')).toBeInTheDocument();
  expect(screen.getByText('до вимкнення о 15:00')).toBeInTheDocument();
  expect(screen.getByText('Відключення: 06:00–08:30, 15:00–19:00')).toBeInTheDocument();
  expect(screen.queryByText('Фактично · EcoFlow')).toBeNull();
});
test('«дані застаріли» once the snapshot is stale', () => {
  view(locOf(), { now: new Date('2026-10-17T10:30:00Z') });
  expect(screen.getByText('дані застаріли')).toBeInTheDocument();
});

describe('EcoFlow only on its location', () => {
  /** Nothing of the station on the schedule tab: no «Фактично» row, no chip, no section, no prompt to connect. */
  function expectNoEcoflow(container: HTMLElement) {
    expect(screen.queryByText('Фактично')).toBeNull();
    expect(container.querySelector('.sv-actual-row')).toBeNull();
    expect(container.querySelector('[data-actual-part]')).toBeNull();
    expect(screen.queryByText('Фактично · EcoFlow')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Фактичні відключення/ })).toBeNull();
    expect(screen.queryByText('Підключіть EcoFlow, щоб бачити, чи є світло насправді')).toBeNull();
    expect(screen.queryByRole('button', { name: /Підключити/ })).toBeNull();
  }

  test('a location state with actual shows the actual row; the other location shows neither the row nor «Підключити EcoFlow»', () => {
    const settings = settingsOf({ actualSource: SOURCE });
    const home = view(actualLoc(HISTORY), { settings });
    expect(screen.getByText('Фактично')).toBeInTheDocument();
    expect(home.container.querySelector('[data-actual-part="off"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Фактичні відключення · 7 днів' })).toBeInTheDocument();
    home.unmount();

    const other = view(locOf({ location: PARENTS }), { settings });
    expectNoEcoflow(other.container);
  });

  test('a status that reached another location by mistake is still not shown there', () => {
    const now = new Date('2026-10-17T08:50:00Z');
    const { container } = view(locOf({ location: PARENTS, actual: actualOf([{ power: 'off', start: '2026-10-17T08:00:00Z' }], 'off', now) }),
      { now, settings: settingsOf({ actualSource: SOURCE }) });
    expectNoEcoflow(container);
    // The schedule's own status, not the station's.
    expect(screen.getByRole('heading', { level: 2, name: 'Світло є' })).toBeInTheDocument();
  });

  test('not connected: the prompt only on actualLocationId', () => {
    const atHome = view(locOf());
    expect(screen.getByText('Підключіть EcoFlow, щоб бачити, чи є світло насправді')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
    atHome.unmount();

    const atParents = view(locOf({ location: PARENTS }));
    expectNoEcoflow(atParents.container);
    atParents.unmount();

    // The station's location points at Батьки: the prompt moves there.
    const moved = view(locOf({ location: PARENTS }), { settings: settingsOf({ actualLocationId: 'b' }) });
    expect(screen.getByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
    moved.unmount();

    // No location for the station: no prompt anywhere.
    for (const location of [HOME, PARENTS]) {
      const r = view(locOf({ location }), { settings: settingsOf({ actualLocationId: null }) });
      expectNoEcoflow(r.container);
      r.unmount();
    }
  });
});

describe('emergency', () => {
  const emergencyLoc = (): LocationState => locOf({
    snapshot: fixtureSnapshot({ fetchedAt: '2026-10-17T11:15:00.000Z', currentOutage: { kind: 'emergency', text: 'Аварійні ремонтні роботи', start: '13:30 17.10.2026', end: '17:00 17.10.2026' } }),
  });
  const at1420 = new Date('2026-10-17T11:20:00Z');

  test('banner, badge, «≈» countdown and the emergency in the outage line', () => {
    view(emergencyLoc(), { now: at1420 });
    expect(screen.getByText('Аварійне відключення')).toBeInTheDocument();
    expect(screen.getByText('ДТЕК: «Аварійні ремонтні роботи»')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Світла немає' })).toBeInTheDocument();
    expect(screen.getByText('≈2:40')).toBeInTheDocument();
    expect(screen.getByText('Відключення: 06:00–08:30, 15:00–19:00 · аварійне з 13:30')).toBeInTheDocument();
  });
  test('the legend has «Аварійне» only while the shown day has emergency cells', async () => {
    const { container } = view(emergencyLoc(), { now: at1420 });
    const legend = () => screen.getByRole('group', { name: 'Легенда' });
    expect(within(legend()).getByText('Аварійне')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-cell="emergency"]')).toHaveLength(7);
    await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
    expect(within(legend()).queryByText('Аварійне')).toBeNull();
  });
  test('a planned outage: banner «Планове відключення» and the «Планове» legend entry', () => {
    const base = emergencyLoc();
    const snapshot = { ...base.snapshot!, currentOutage: { kind: 'planned' as const, text: 'Планове вимкнення', start: '13:30 17.10.2026', end: '17:00 17.10.2026' } };
    view({ ...base, snapshot }, { now: at1420 });
    expect(screen.getByText('Планове відключення')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Легенда' })).getByText('Планове')).toBeInTheDocument();
  });
  test('the snapshot note shows only on today\'s tab, in data-capture="note"', async () => {
    const { container } = view(locOf({ snapshot: { ...fixtureSnapshot(), note: 'X' } }), { now: at1420 });
    expect(container.querySelector('[data-capture="note"]')).toHaveTextContent('X');
    await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
    expect(container.querySelector('[data-capture="note"]')).toBeNull();
  });
  test('the note belongs to the day it was fetched: a 23:50 note is gone at 00:10', () => {
    const noted = (fetchedAt: string): LocationState => locOf({ snapshot: { ...fixtureSnapshot({ fetchedAt }), note: 'X' } });
    const at0010 = new Date('2026-10-16T21:10:00Z'); // 00:10 on 17.10 in Kyiv
    const { container, unmount } = view(noted('2026-10-16T20:50:00.000Z'), { now: at0010 }); // fetched 23:50 on 16.10
    expect(container.querySelector('[data-capture="note"]')).toBeNull();
    unmount();
    const same = view(noted('2026-10-16T21:05:00.000Z'), { now: at0010 }); // fetched 00:05 on 17.10
    expect(same.container.querySelector('[data-capture="note"]')).toHaveTextContent('X');
  });
  test('no emergency → no «Аварійне» in the legend', () => {
    view(locOf(), { now: at1420 });
    expect(within(screen.getByRole('group', { name: 'Легенда' })).getAllByText(/./).map(e => e.textContent))
      .toEqual(['Світло є', 'Немає', 'Можливо немає', 'Невідомо']);
  });
});
