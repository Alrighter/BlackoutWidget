'use strict';
/**
 * Fake app states for the UI capture rig (see README.md). Scenario names, day schedules, clock times and the EcoFlow
 * history are the mockup's SCEN (docs/superpowers/specs/assets/design-2026-10-18/widget-compact.html); address, lines
 * and queue are those of tests/helpers/snapshot.ts. Times are Kyiv wall time on the clock's Kyiv day.
 */

const KYIV_TZ = 'Europe/Kyiv';
/** The mockup's day (and the DTEK fixture's). */
const DEFAULT_DATE = '2026-10-17';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const pad = n => String(n).padStart(2, '0');

function kyivParts(ms) {
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
function kyivDateKey(ms) {
  const p = kyivParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
function kyivOffsetMs(ms) {
  const p = kyivParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Instant (ms) of the Kyiv wall time `minutes` after midnight of `dateKey` (as kyivWallTimeToInstant in src/shared/time.ts). */
function kyivWall(dateKey, minutes) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  return wall - kyivOffsetMs(wall - kyivOffsetMs(wall));
}
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const mins = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const dmy = dateKey => { const [y, m, d] = dateKey.split('-'); return `${d}.${m}.${y}`; };

const SLOT = { 1: 'on', 0: 'off', '?': 'maybe-off', x: 'unknown' };
/** The mockup's sched(): 48 half-hour slots of `base`, with [fromHour, toHour, char] spans painted over. */
function sched(base, spans) {
  const a = new Array(48).fill(base);
  for (const [from, to, c] of spans) for (let i = Math.round(from * 2); i < Math.round(to * 2); i++) a[i] = c;
  return a.map(c => SLOT[c]);
}

const T_A = sched('1', [[4, 7.5, '0'], [15, 19, '0'], [22, 24, '?']]);
// The mockup's T_E is this day with 13:30-17:00 painted as emergency; here the emergency is currentOutage, as in the app.
const T_B = sched('1', [[4, 7.5, '0'], [15, 19, '0']]);
const T_C = sched('1', [[12, 14.5, '0'], [20, 23.5, '0']]);
const M_A = sched('1', [[1, 4.5, '0'], [11, 14, '?'], [19, 22.5, '0']]);

/** EcoFlow history as [start, power]: each segment ends where the next starts, the last one is open (mockup A1-A3). */
const A1 = [['00:00', 'on'], ['02:10', 'unknown'], ['03:40', 'on'], ['12:04', 'off'], ['14:32', 'on']];
const A2 = [['00:00', 'on'], ['02:10', 'unknown'], ['03:40', 'on'], ['12:04', 'off'], ['14:26', 'on'], ['14:32', 'off']];
const A3 = [['00:00', 'on'], ['04:02', 'off'], ['07:34', 'on'], ['10:20', 'unknown']];
/** Earlier days, so the main window's 7-day outage list has entries (main-schedule.html): [dayOffset, start, power]. */
const PAST = [[-2, '00:00', 'on'], [-2, '08:00', 'off'], [-2, '12:04', 'on'], [-1, '16:02', 'off'], [-1, '19:58', 'on']];

const S_ON = { now: '11:50', updated: '11:45', today: T_A, tomorrow: M_A };
/**
 * Deviations from SCEN, so the app's own logic lands in the scenario's state: nodata has no day at all (an
 * all-unknown day reads «Без змін…»); nochange has no tomorrow (M_A would bring a change at 01:00).
 */
const SCENARIOS = {
  on: S_ON,
  off: { now: '17:55', updated: '17:50', today: T_A, tomorrow: null },
  maybe: { now: '22:20', updated: '22:10', today: T_A, tomorrow: M_A },
  emergency: { now: '14:20', updated: '14:15', today: T_B, tomorrow: null, outage: ['13:30', '17:00'] },
  nodata: { now: '06:10', updated: '06:05', today: null, tomorrow: null },
  stale: { now: '20:40', updated: '14:50', today: T_A, tomorrow: M_A },
  warning: { ...S_ON, lineChanged: true },
  nochange: { now: '19:40', updated: '19:30', today: T_B, tomorrow: null },
  ecoMatch: { now: '17:20', updated: '17:15', today: T_C, tomorrow: M_A, actual: A1 },
  ecoMismatch: { now: '15:40', updated: '15:30', today: T_C, tomorrow: M_A, actual: A2 },
  ecoOffline: { ...S_ON, actual: A3, reason: 'станція не в мережі' },
};
const SCENARIO_NAMES = Object.keys(SCENARIOS);

const LINES = [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }, { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' }];
const ADDRESS = {
  providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2',
};
/** The second location's house: another address, so nothing implies the two share data (only the fake schedule is the same). */
const PARENTS_ADDRESS = {
  providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'вул. Ярослава Мудрого', house: '12', lineIndex: 1, groupId: 'GPV1.2',
};
const ECOFLOW_DEVICE = { sn: 'R331ZEB4ZEA00142', label: 'Delta 2' };

/** 'HH:MM' = that Kyiv time on DEFAULT_DATE; anything else is parsed as a date-time (e.g. 2026-10-17T11:50:00+03:00). */
function parseNow(text) {
  if (/^\d{1,2}:\d{2}$/.test(text)) return kyivWall(DEFAULT_DATE, mins(text));
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`--now: cannot read "${text}" (use HH:MM or an ISO date-time)`);
  return ms;
}

/**
 * The scenario's AppState, the clock (ms) the renderer must see, and what the stubbed window.api returns.
 * `now` (optional, see parseNow) moves only the clock: the scenario's times stay on the clock's Kyiv day.
 * `locations` 1 or 2: the second is «Батьки» (id `parents`) with the same schedule at its own address. `widget` is the
 * first location's WidgetState, as widgetStateOf in src/main/compose-state.ts builds it.
 */
function buildScenario(name, { style = 'compact', now, locations = 1 } = {}) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario "${name}" (one of: ${SCENARIO_NAMES.join(', ')})`);
  const nowMs = now ? parseNow(now) : kyivWall(DEFAULT_DATE, mins(s.now));
  const day = kyivDateKey(nowMs);
  const at = (hm, dayOffset = 0) => kyivWall(addDays(day, dayOffset), mins(hm));
  const iso = ms => new Date(ms).toISOString();

  const days = [];
  if (s.today) days.push({ date: day, slots: s.today });
  if (s.tomorrow) days.push({ date: addDays(day, 1), slots: s.tomorrow });
  const snapshot = {
    providerId: 'dtek-krem', address: ADDRESS, groupId: 'GPV1.2', groupLabel: 'Черга 1.2', days,
    sourceUpdatedAt: `${dmy(day)} ${s.updated}`, // DTEK fact.update format
    fetchedAt: iso(Math.min(at(s.updated), nowMs)),
    lines: LINES,
  };
  if (s.outage) {
    snapshot.outageActive = true;
    snapshot.currentOutage = {
      kind: 'emergency', text: 'Аварійні ремонтні роботи', groups: ['GPV1.2'],
      start: `${s.outage[0]} ${dmy(day)}`, end: `${s.outage[1]} ${dmy(day)}`, // DTEK start_date / end_date format
    };
  }

  let actual = null;
  let actualSource = null;
  if (s.actual) {
    const segs = [...PAST, ...s.actual.map(([hm, power]) => [0, hm, power])]
      .map(([offset, hm, power]) => ({ power, start: at(hm, offset) }))
      .filter(seg => seg.start < nowMs);
    const history = segs.map((seg, i) => ({
      power: seg.power, start: iso(seg.start), ...(i < segs.length - 1 ? { end: iso(segs[i + 1].start) } : {}),
    }));
    const last = segs[segs.length - 1];
    actual = {
      sourceLabel: `EcoFlow · ${ECOFLOW_DEVICE.label}`, power: last.power, observedAt: iso(nowMs - 60_000), history,
      ...(last.power === 'unknown' ? { reason: s.reason ?? 'не вдається визначити' } : { since: iso(last.start) }),
    };
    actualSource = { id: 'ecoflow', region: 'eu', deviceSn: ECOFLOW_DEVICE.sn, deviceName: ECOFLOW_DEVICE.label, accessKeyHint: 'Fp4S…' };
  }

  const own = (id, name, address) => ({
    location: { id, name, address, widgetStyle: style, widgetPosition: null },
    snapshot: { ...snapshot, address }, phase: 'ok', lineChanged: s.lineChanged === true,
  });
  const states = [{ ...own('home', 'Дім', ADDRESS), actual }];
  if (locations >= 2) states.push(own('parents', 'Батьки', PARENTS_ADDRESS));
  // As composeAppState: the station's status is on the EcoFlow location and, for the EcoFlow card, on AppState.
  const state = {
    settings: {
      locations: states.map(l => l.location), actualLocationId: 'home', autostart: true, actualSource,
    },
    locations: states, actual, settingsLoaded: true,
  };
  const widget = { location: states[0], showName: states.length > 1 };
  const stubs = {
    // Same name as PROVIDER_NAMES in src/shared/providers.ts.
    providers: [{ id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' }],
    cities: ['м. Біла Церква', 'м. Бориспіль', 'м. Бровари', 'м. Буча', 'м. Васильків', 'м. Ірпінь'],
    streets: ['бул. Грушевського Михайла', 'вул. Ярослава Мудрого', 'вул. Шевченка', 'вул. Київська'],
    houses: [
      { house: '38', lines: [LINES[0]], outageActive: false },
      { house: '40', lines: LINES, outageActive: false },
      { house: '42', lines: [LINES[1]], outageActive: false },
    ],
    houseLines: LINES,
    previewLines: [{ line: LINES[0], today: { date: day, slots: T_A } }, { line: LINES[1], today: { date: day, slots: T_C } }],
    // What window.api's EcoFlow calls resolve with; --stubs replaces them ("pending": never settles).
    ecoflowTest: { ok: true, devices: [{ ...ECOFLOW_DEVICE, online: true }] },
    ecoflowScan: { nearby: [] },
    ecoflowPreview: { ok: true, online: true, power: 'on', detail: 'на вході 229 В' },
    ecoflowSave: { ok: true },
  };
  return { nowMs, state, widget, stubs };
}

module.exports = { SCENARIO_NAMES, DEFAULT_DATE, buildScenario };
