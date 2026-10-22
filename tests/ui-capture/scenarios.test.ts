import { createRequire } from 'node:module';
import type { AppState, WidgetState } from '../../src/shared/types';
import { computeWidgetView, type WidgetView } from '../../src/shared/widget-state';

interface Rig {
  SCENARIO_NAMES: string[];
  buildScenario(
    name: string, opts?: { style?: string; now?: string; locations?: number },
  ): { nowMs: number; state: AppState; widget: WidgetState };
}
const rig = createRequire(import.meta.url)('../../scripts/ui-capture/scenarios.cjs') as Rig;

function view(name: string, now?: string): { view: WidgetView; state: AppState } {
  const { nowMs, state } = rig.buildScenario(name, { now });
  return { view: computeWidgetView(state.locations[0].snapshot!, new Date(nowMs), state.locations[0].actual), state };
}

// What the mockup's SCEN (widget-compact.html) shows for each scenario, as the app's own logic computes it.
const EXPECTED: Record<string, Partial<WidgetView>> = {
  on: { state: 'on', nextText: 'Вимкнення о 15:00 · через 3 год 10 хв', updatedText: 'оновлено 11:45', stale: false },
  off: { state: 'off', nextText: 'Увімкнуть о 19:00 · через 1 год 5 хв', updatedText: 'оновлено 17:50' },
  maybe: {
    state: 'maybe-off', nextText: 'Можливо без світла до 24:00 · ще 1 год 40 хв', countdownShort: '1:40',
    countdownCaption: 'можливо до 24:00', updatedText: 'оновлено 22:10',
  },
  emergency: {
    state: 'emergency', outageBadge: 'Аварійне', nextText: 'Аварійне · орієнтовно до 17:00', countdownShort: '2:40',
    countdownCaption: 'орієнтовно до 17:00',
  },
  nodata: { state: 'unknown', nextText: 'Графік на сьогодні ще не отримано', today: null },
  stale: { state: 'on', stale: true, nextText: 'Можливе вимкнення о 22:00 · через 1 год 20 хв', updatedText: 'оновлено 14:50' },
  warning: { state: 'on', nextText: 'Вимкнення о 15:00 · через 3 год 10 хв' },
  nochange: { state: 'on', nextText: 'Без змін до кінця графіка' },
  ecoMatch: {
    state: 'on', actual: { power: 'on', sinceText: 'з 14:32', mismatch: false },
    nextText: 'Вимкнення о 20:00 · через 2 год 40 хв', updatedText: 'оновлено 17:15',
  },
  ecoMismatch: { state: 'off', actual: { power: 'off', sinceText: 'з 14:32', mismatch: true }, nextText: 'Не за графіком · з 14:32' },
  ecoOffline: { state: 'on', actualUnknownReason: 'станція не в мережі', nextText: 'Вимкнення о 15:00 · через 3 год 10 хв' },
};

describe('UI capture rig scenarios', () => {
  it('has the mockup scenario names', () => {
    expect(rig.SCENARIO_NAMES).toEqual(Object.keys(EXPECTED));
  });

  it.each(Object.keys(EXPECTED))('%s lands in the mockup state', name => {
    const { view: v, state } = view(name);
    expect(v).toMatchObject(EXPECTED[name]);
    expect(v.lineLabel).toBe('Лінія 1 · черга 1.2');
    expect(state.locations[0].lineChanged).toBe(name === 'warning');
    expect(!!state.locations[0].actual).toBe(name.startsWith('eco'));
    expect(!!state.actual).toBe(name.startsWith('eco'));
  });

  it('draws the EcoFlow line up to now, the unknown stretch included', () => {
    expect(view('ecoMatch').view.actualStrip).toEqual([
      { startMin: 0, endMin: 130, power: 'on' }, { startMin: 130, endMin: 220, power: 'unknown' },
      { startMin: 220, endMin: 724, power: 'on' }, { startMin: 724, endMin: 872, power: 'off' },
      { startMin: 872, endMin: 1040, power: 'on' },
    ]);
    expect(view('ecoOffline').view.actualStrip?.at(-1)).toEqual({ startMin: 620, endMin: 710, power: 'unknown' });
  });

  it('--now moves only the clock', () => {
    const { view: v } = view('on', '13:00');
    expect([v.state, v.nextText, v.updatedText]).toEqual(['on', 'Вимкнення о 15:00 · через 2 год', 'оновлено 11:45']);
    expect(view('off', '2026-10-20T16:00:00+03:00').view).toMatchObject({ todayKey: '2026-10-20', state: 'off' });
  });

  it('one location by default: no name on the widget, the EcoFlow status on the location and on AppState', () => {
    const { state, widget } = rig.buildScenario('ecoMatch');
    expect(state.locations.map(l => l.location.name)).toEqual(['Дім']);
    expect(state.settings.locations).toEqual(state.locations.map(l => l.location));
    expect(state.settings.actualLocationId).toBe('home');
    expect(widget.showName).toBe(false);
    expect(widget.location).toBe(state.locations[0]);
    expect(state.actual).toBe(state.locations[0].actual);
  });

  it('--locations 2 adds «Батьки» with the same snapshot data, EcoFlow only on the first', () => {
    const { state, widget } = rig.buildScenario('ecoMatch', { locations: 2 });
    expect(state.locations.map(l => l.location.name)).toEqual(['Дім', 'Батьки']);
    expect(state.settings.locations.map(l => l.id)).toEqual(['home', 'parents']);
    expect(widget.showName).toBe(true);
    expect(widget.location.location.id).toBe('home');
    const [home, parents] = state.locations;
    expect(parents.snapshot!.days).toEqual(home.snapshot!.days);
    expect(parents.snapshot!.address).not.toEqual(home.snapshot!.address);
    expect(parents.location.address).toEqual(parents.snapshot!.address);
    expect(home.actual).toBeTruthy();
    expect(parents.actual).toBeUndefined();
    expect(state.actual).toBe(home.actual);
  });
});
