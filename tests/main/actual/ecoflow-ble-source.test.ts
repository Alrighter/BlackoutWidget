import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INV_SILENT_MS, type BleLinkLike, type LinkEvent } from '../../../src/main/actual/ecoflow/ble/link';
import { EcoflowBleSource, LINK_GRACE_MS, READING_MS, REASON_REPEAT_MS } from '../../../src/main/actual/ecoflow/ble/source';
import type { ActualReading } from '../../../src/main/actual/types';
import { BLE_REASON } from '../../../src/shared/ecoflow-ble';

const SN = 'R601ZEB4XXXX0000';
const OTHER_SN = 'R601ZEB4YYYY1111';
const TOKEN = '0123456789ABCDEF0123456789ABCDEF';
const T0 = Date.parse('2026-10-19T10:00:00Z');

class FakeLink implements BleLinkLike {
  cbs = new Set<(e: LinkEvent) => void>();
  connected: string | null = null;
  watch = vi.fn<(sn: string, token: string) => void>();
  unwatch = vi.fn<() => void>();
  scan = vi.fn(() => Promise.resolve({ adverts: [] }));
  connectedSn() { return this.connected; }
  onEvent(cb: (e: LinkEvent) => void) { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; }
  emit(e: LinkEvent) { for (const cb of [...this.cbs]) cb(e); }
}

function setup() {
  const link = new FakeLink();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const source = new EcoflowBleSource({ sn: SN, token: TOKEN }, link, { log });
  const readings: ActualReading[] = [];
  const start = () => source.start(r => readings.push(r));
  const state = (state: 'connected' | 'lost' | 'refused' | 'stalled' | 'unsupported' | 'searching', sn = SN) =>
    link.emit({ ev: 'link', sn, state });
  const inv = (fields: Record<string, number>, sn = SN) => link.emit({ ev: 'heartbeat', sn, module: 'inv', fields });
  const mppt = (fields: Record<string, number>) => link.emit({ ev: 'heartbeat', sn: SN, module: 'mppt', fields });
  const GRID = { acInVol: 119_189, acInFreq: 60, inputWatts: 100 };
  return { link, log, source, readings, start, state, inv, mppt, GRID };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

describe('EcoflowBleSource', () => {
  it('start watches the station with its token', () => {
    const { link, start } = setup();
    start();
    expect(link.watch).toHaveBeenCalledWith(SN, TOKEN);
  });

  it('inverter heartbeat with 119189 mV reports on', () => {
    const { start, state, inv, readings, GRID } = setup();
    start();
    state('connected');
    inv(GRID);
    expect(readings).toEqual([{ power: 'on', observedAt: new Date(T0).toISOString(), detail: 'на вході 119 В' }]);
  });

  it('0 V and 0 Hz reports off', () => {
    const { start, state, inv, readings } = setup();
    start();
    state('connected');
    inv({ acInVol: 0, acInFreq: 0, inputWatts: 0 });
    expect(readings).toHaveLength(1);
    expect(readings[0].power).toBe('off');
  });

  it('throttles to one reading per 10 s unless the power changes', () => {
    const { start, state, inv, readings, GRID } = setup();
    start();
    state('connected');
    inv(GRID);
    vi.advanceTimersByTime(READING_MS - 1000);
    inv(GRID);
    expect(readings).toHaveLength(1);
    inv({ acInVol: 0, acInFreq: 0, inputWatts: 0 });
    expect(readings.map(r => r.power)).toEqual(['on', 'off']);
    vi.advanceTimersByTime(READING_MS);
    inv({ acInVol: 0, acInFreq: 0, inputWatts: 0 });
    expect(readings).toHaveLength(3);
    expect(readings[2].observedAt).toBe(new Date(T0 + READING_MS - 1000 + READING_MS).toISOString());
  });

  it('20 s without an inverter heartbeat reports unknown, with the AC-off hint when MPPT says 0', () => {
    const a = setup();
    a.start();
    a.state('connected');
    a.inv(a.GRID);
    a.readings.length = 0;
    vi.advanceTimersByTime(INV_SILENT_MS - 1000);
    expect(a.readings).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(a.readings).toEqual([expect.objectContaining({ power: 'unknown', reason: BLE_REASON.invSilent })]);

    const b = setup();
    b.start();
    b.state('connected');
    b.mppt({ cfgAcEnabled: 0 });
    vi.advanceTimersByTime(INV_SILENT_MS + 1000);
    expect(b.readings).toEqual([expect.objectContaining({ power: 'unknown', reason: BLE_REASON.invSilent + BLE_REASON.acOffHint })]);
  });

  it('a drop shorter than 30 s reports nothing; longer reports «станція поза зв’язком Bluetooth»', () => {
    const { start, state, inv, readings, GRID } = setup();
    start();
    state('connected');
    inv(GRID);
    readings.length = 0;
    vi.advanceTimersByTime(5_000);
    state('lost');
    vi.advanceTimersByTime(LINK_GRACE_MS - 1000);
    expect(readings).toEqual([]);
    state('connected');
    inv(GRID);
    vi.advanceTimersByTime(5_000);
    state('lost');
    vi.advanceTimersByTime(LINK_GRACE_MS + 1000);
    const last = readings[readings.length - 1];
    expect(last).toMatchObject({ power: 'unknown', reason: 'станція поза зв’язком Bluetooth' });
  });

  it('never connecting reports lost only after the grace from start', () => {
    const { start, readings } = setup();
    start();
    vi.advanceTimersByTime(LINK_GRACE_MS - 1000);
    expect(readings).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(readings).toEqual([expect.objectContaining({ power: 'unknown', reason: BLE_REASON.lost })]);
  });

  it('refused / stalled / unsupported / bt-off / host-failed map to their reasons', () => {
    const cases: Array<[string, (s: ReturnType<typeof setup>) => void, string]> = [
      ['refused', s => s.state('refused'), BLE_REASON.refused],
      ['stalled', s => s.state('stalled'), BLE_REASON.stalled],
      ['unsupported', s => s.state('unsupported'), BLE_REASON.unsupported],
      ['bt-off', s => s.link.emit({ ev: 'adapter', state: 'poweredOff' }), BLE_REASON['bt-off']],
      ['bt-denied', s => s.link.emit({ ev: 'adapter', state: 'unauthorized' }), BLE_REASON['bt-denied']],
      ['bt-missing', s => s.link.emit({ ev: 'adapter', state: 'unsupported' }), BLE_REASON['bt-missing']],
      ['bt-unavailable', s => s.link.emit({ ev: 'adapter', state: 'resetting' }), BLE_REASON['bt-unavailable']],
      ['host-failed', s => s.link.emit({ ev: 'host-failed' }), BLE_REASON['host-failed']],
    ];
    for (const [name, apply, reason] of cases) {
      const s = setup();
      s.start();
      apply(s);
      vi.advanceTimersByTime(LINK_GRACE_MS - 1000);
      expect(s.readings, name).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(s.readings, name).toEqual([{ power: 'unknown', observedAt: expect.any(String), reason }]);
    }
  });

  it('host-failed ends on an adapter state other than unknown, not on unknown', () => {
    const { link, start, readings } = setup();
    start();
    link.emit({ ev: 'host-failed' });
    link.emit({ ev: 'adapter', state: 'unknown' });
    vi.advanceTimersByTime(LINK_GRACE_MS + 1000);
    expect(readings[0].reason).toBe(BLE_REASON['host-failed']);
    link.emit({ ev: 'adapter', state: 'poweredOn' });
    vi.advanceTimersByTime(REASON_REPEAT_MS);
    expect(readings[readings.length - 1].reason).toBe(BLE_REASON.lost);
  });

  it('repeats an unknown reason every 60 s', () => {
    const { start, readings } = setup();
    start();
    vi.advanceTimersByTime(LINK_GRACE_MS + 1000);
    expect(readings).toHaveLength(1);
    vi.advanceTimersByTime(REASON_REPEAT_MS - 2000);
    expect(readings).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(readings).toHaveLength(2);
    vi.advanceTimersByTime(REASON_REPEAT_MS);
    expect(readings).toHaveLength(3);
  });

  it('ignores events of another station and non-link events', () => {
    const { link, start, state, inv, readings, GRID } = setup();
    start();
    state('connected', OTHER_SN);
    inv(GRID, OTHER_SN);
    link.emit({ ev: 'log', level: 'info', msg: 'x' } as unknown as LinkEvent);
    expect(readings).toEqual([]);
    vi.advanceTimersByTime(LINK_GRACE_MS + 1000);
    expect(readings[0].reason).toBe(BLE_REASON.lost);
  });

  it('starts connected when the link already is', () => {
    const { link, start, readings } = setup();
    link.connected = SN;
    start();
    vi.advanceTimersByTime(LINK_GRACE_MS + INV_SILENT_MS);
    expect(readings[0].reason).toBe(BLE_REASON.invSilent);
  });

  it('stop unwatches and stays silent', () => {
    const { link, source, start, state, inv, readings, GRID } = setup();
    start();
    state('connected');
    source.stop();
    expect(link.unwatch).toHaveBeenCalledTimes(1);
    expect(link.cbs.size).toBe(0);
    inv(GRID);
    vi.advanceTimersByTime(10 * REASON_REPEAT_MS);
    expect(readings).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
