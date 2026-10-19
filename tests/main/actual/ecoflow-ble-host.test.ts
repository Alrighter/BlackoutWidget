import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MS, BAD_FRAME_LIMIT, BleHost, CONNECT_TIMEOUT_MS, REFUSED_PAUSE_MS, SCAN_FIND_MS, SILENT_LINK_MS,
  STALL_PAUSE_MS, UNSUPPORTED_RECHECK_MS, type BleCentral, type BleChannel, type BlePeripheral,
} from '../../../src/main/actual/ecoflow/ble/host';
import type { AdapterState, HostEvent } from '../../../src/main/actual/ecoflow/ble/messages';
import { encodePacket } from '../../../src/main/actual/ecoflow/ble/protocol';
import { fakeStation, INV, MPPT, PD, type FakeStation, type StationOptions } from '../../helpers/ble-station';

const SN = 'R601ZEB4XXXX0000';
const TOKEN = '0123456789ABCDEF0123456789ABCDEF';
const OTHER_TOKEN = 'FEDCBA9876543210FEDCBA9876543210';
/** The fake central repeats every nearby advert this often while it scans. */
const ADVERT_MS = 1_000;
/** The session's own stage timeout (its default). */
const STAGE_MS = 15_000;

/** Manufacturer data: company id, protocol byte, SN, SoC, product type, then the capability byte (encrypt type in bits 3–5). */
const advertData = (sn: string, encryptType = 7, soc = 87) => Buffer.concat([
  Buffer.from('b5b513', 'hex'), Buffer.from(sn.padEnd(16, '\0'), 'ascii'),
  Buffer.from([soc, 0x00, 0x01, 0x00, 0x00, (encryptType << 3) | 0x06, 0x9c]),
]);

class FakePeripheral implements BlePeripheral {
  connects = 0;
  cancels = 0;
  disconnects = 0;
  /** connect() never settles, as when the phone holds the station. */
  hang = false;
  /** 'none': the characteristic pair is absent; 'broken': writes fail; 'mute': writes never reach the station. */
  channel: 'ok' | 'none' | 'broken' | 'mute' = 'ok';
  /** Called on each connect with its count, to script the station per connection. */
  onConnect?: (n: number) => void;
  private dropCbs: Array<() => void> = [];

  constructor(readonly id: string, readonly station: FakeStation) {}

  connect(): Promise<void> {
    this.connects++;
    this.onConnect?.(this.connects);
    return this.hang ? new Promise<void>(() => {}) : Promise.resolve();
  }

  cancelConnect(): void { this.cancels++; }

  /** Like noble, our own disconnect is reported through the disconnect event too. */
  async disconnect(): Promise<void> {
    this.disconnects++;
    this.drop();
  }

  onceDisconnect(cb: () => void): void { this.dropCbs.push(cb); }

  /** The link goes down. */
  drop(): void {
    for (const cb of this.dropCbs.splice(0)) cb();
  }

  async openChannel(onNotify: (data: Buffer) => void): Promise<BleChannel | null> {
    if (this.channel === 'none') return null;
    this.station.attach({ handle: onNotify });
    const { channel } = this;
    return {
      write: async data => {
        if (channel === 'broken') throw new Error('GATT write failed');
        if (channel === 'ok') await this.station.write(data);
      },
    };
  }
}

interface Nearby { peripheral: BlePeripheral; data: Buffer; rssi: number }

class FakeCentral implements BleCentral {
  nearby: Nearby[] = [];
  scanStarts: number[] = [];
  scanStops = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stateCbs: Array<(s: AdapterState) => void> = [];

  constructor(public state: AdapterState) {}

  get scanning(): boolean { return this.ticker !== undefined; }

  onState(cb: (s: AdapterState) => void): void { this.stateCbs.push(cb); }

  setState(s: AdapterState): void {
    this.state = s;
    if (s !== 'poweredOn') this.halt();
    for (const cb of this.stateCbs) cb(s);
  }

  async startScan(onAdvert: (a: { peripheral: BlePeripheral; manufacturerData?: Buffer; rssi: number }) => void): Promise<void> {
    if (this.state !== 'poweredOn') throw new Error('adapter not powered on');
    this.scanStarts.push(Date.now());
    this.halt();
    this.ticker = setInterval(() => {
      for (const n of this.nearby) onAdvert({ peripheral: n.peripheral, manufacturerData: n.data, rssi: n.rssi });
    }, ADVERT_MS);
  }

  async stopScan(): Promise<void> {
    this.scanStops++;
    this.halt();
  }

  private halt(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}

function setup(adapter: AdapterState = 'poweredOn') {
  const central = new FakeCentral(adapter);
  const events: HostEvent[] = [];
  const host = new BleHost(central, e => events.push(e));
  /** A station nearby, advertising; it accepts TOKEN. */
  const place = (o: { sn?: string; encryptType?: number; rssi?: number; station?: Partial<StationOptions> } = {}) => {
    const sn = o.sn ?? SN;
    const station = fakeStation({ sn, token: TOKEN, heartbeatOnAuth: false, ...o.station });
    const peripheral = new FakePeripheral(`peripheral-${sn}`, station);
    central.nearby.push({ peripheral, data: advertData(sn, o.encryptType), rssi: o.rssi ?? -60 });
    return { station, peripheral };
  };
  const watch = (token = TOKEN, sn = SN) => host.handle({ cmd: 'watch', sn, token });
  const links = () => events.flatMap(e => (e.ev === 'link' ? [e.state] : []));
  const lastLink = () => events.filter(e => e.ev === 'link').at(-1);
  const heartbeats = () => events.flatMap(e => (e.ev === 'heartbeat' ? [e.module] : []));
  return { central, events, host, place, watch, links, lastLink, heartbeats };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Advances the clock a second at a time until `done()` holds. */
async function until(done: () => boolean, limitMs = 3_600_000): Promise<void> {
  for (let waited = 0; !done(); waited += 1_000) {
    if (waited >= limitMs) throw new Error('condition not reached');
    await advance(1_000);
  }
}

// queueMicrotask stays real: the station double answers through it.
beforeEach(() => vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('BLE host: the watched station', () => {
  it('watches: searching → connecting → connected, then forwards inverter heartbeats', async () => {
    const { events, place, watch } = setup();
    const { station } = place();
    watch();
    await advance(ADVERT_MS);
    station.emit(INV);
    await advance(0);

    expect(events.filter(e => e.ev !== 'log')).toEqual([
      { ev: 'adapter', state: 'poweredOn' },
      { ev: 'link', sn: SN, state: 'searching' },
      { ev: 'link', sn: SN, state: 'connecting' },
      { ev: 'link', sn: SN, state: 'connected' },
      { ev: 'heartbeat', sn: SN, module: 'inv', fields: expect.objectContaining({ acInVol: 119189, acInFreq: 60, inputWatts: 497 }) },
    ]);
    // One log line per link change, with the SN prefix only; no text carries the full SN, nothing carries the token.
    const logs = events.flatMap(e => (e.ev === 'log' ? [e.text] : []));
    expect(logs).toEqual(['R601… searching', 'R601… connecting', 'R601… connected']);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('passes on a heartbeat that came with the auth reply once connected is posted', async () => {
    const { events, place, watch } = setup();
    place({ station: { heartbeatOnAuth: true } });
    watch();
    await advance(ADVERT_MS);
    expect(events.filter(e => e.ev === 'link' || e.ev === 'heartbeat').map(e => (e.ev === 'link' ? e.state : e.module)))
      .toEqual(['searching', 'connecting', 'connected', 'inv']);
  });

  it('does not forward ems/bms heartbeats, nor inverter ids outside command set 0x20', async () => {
    const { place, watch, heartbeats } = setup();
    const { station } = place();
    watch();
    await advance(ADVERT_MS);
    station.emit(encodePacket({ src: 0x03, dst: 0x21, cmdSet: 0x20, cmdId: 0x02, payload: Buffer.alloc(40) }));
    station.emit(encodePacket({ src: 0x03, dst: 0x21, cmdSet: 0x20, cmdId: 0x32, payload: Buffer.alloc(80) }));
    // The inverter's ids under another command set are no heartbeat.
    station.emit(encodePacket({ src: 0x04, dst: 0x21, cmdSet: 0x32, cmdId: 0x02, payload: Buffer.alloc(70) }));
    station.emit(PD);
    station.emit(MPPT);
    station.emit(INV);
    await advance(0);
    expect(heartbeats()).toEqual(['pd', 'mppt', 'inv']);
  });

  it('retries a missing station with 5, 10, 20, 40, 60, 60 s backoff', async () => {
    const { central, watch, links } = setup();
    watch();
    await advance(6 * SCAN_FIND_MS + 5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    // Each attempt rescans for SCAN_FIND_MS; the backoff is the quiet time after it.
    const gaps = central.scanStarts.slice(1).map((t, i) => t - central.scanStarts[i] - SCAN_FIND_MS);
    expect(gaps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(central.scanStops).toBe(6);
    expect(links()).toEqual(['searching']);
  });

  it('cancels a connect that hangs for 20 s and backs off', async () => {
    const { central, place, watch, lastLink } = setup();
    const { peripheral } = place();
    peripheral.hang = true;
    watch();
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(1);
    await advance(CONNECT_TIMEOUT_MS - 1);
    expect(peripheral.cancels).toBe(0);
    await advance(1);
    expect(peripheral.cancels).toBe(1);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'searching', detail: 'connect timeout' });
    await advance(BACKOFF_MS[0] - 1);
    expect(central.scanStarts).toHaveLength(1);
    await advance(1);
    expect(central.scanStarts).toEqual([0, ADVERT_MS + CONNECT_TIMEOUT_MS + BACKOFF_MS[0]]);
  });

  it('a missing channel, a failed write or a silent key exchange backs off and is no stall', async () => {
    const { central, events, place, watch, links } = setup();
    const { peripheral } = place();
    const script: Array<FakePeripheral['channel']> = ['none', 'broken', 'mute', 'mute', 'mute', 'ok'];
    peripheral.onConnect = n => { peripheral.channel = script[n - 1]; };
    watch();
    await until(() => links().at(-1) === 'connected');
    expect(events.flatMap(e => (e.ev === 'link' && e.detail ? [e.detail] : []))).toEqual([
      'no channel', 'public-key failed', 'no reply in public-key', 'no reply in public-key', 'no reply in public-key',
    ]);
    expect(links()).not.toContain('stalled');
    expect(peripheral.disconnects).toBe(5);
    // Between scans: the advert, the failure (a silent stage takes STAGE_MS), then the backoff.
    const gaps = central.scanStarts.slice(1).map((t, i) => t - central.scanStarts[i]);
    expect(gaps).toEqual([
      ADVERT_MS + BACKOFF_MS[0], ADVERT_MS + BACKOFF_MS[1], ADVERT_MS + STAGE_MS + BACKOFF_MS[2],
      ADVERT_MS + STAGE_MS + BACKOFF_MS[3], ADVERT_MS + STAGE_MS + BACKOFF_MS[4],
    ]);
  });

  it('an unexpected error names its class, never its message', async () => {
    const { events, host, place, watch, lastLink } = setup();
    const { peripheral } = place();
    peripheral.connect = () => { throw new TypeError(`bad state ${TOKEN}`); };
    watch();
    await advance(ADVERT_MS);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'searching', detail: 'unexpected error (TypeError)' });
    host.handle({ cmd: 'unwatch' });
    host.handle({ cmd: 'probe', id: 5 });
    await advance(ADVERT_MS);
    expect(events.at(-1)).toEqual({ ev: 'probe-result', id: 5, ok: false, detail: 'R601… unexpected error (TypeError)' });
    expect(JSON.stringify(events)).not.toContain('bad state');
  });

  it('a refusal pauses 30 min and posts refused with the code', async () => {
    const { central, place, watch, links, lastLink } = setup();
    const { peripheral } = place();
    watch(OTHER_TOKEN);
    await advance(ADVERT_MS);
    expect(links()).toEqual(['searching', 'connecting', 'refused']);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'refused', detail: 'auth code 6' });
    expect(peripheral.disconnects).toBe(1);
    await advance(REFUSED_PAUSE_MS - 1);
    expect(peripheral.connects).toBe(1);
    expect(central.scanStarts).toHaveLength(1);
    await advance(1 + ADVERT_MS);
    expect(peripheral.connects).toBe(2);
  });

  it('three stalls in a row pause 5 min; a good session resets the count', async () => {
    const { place, watch, links, lastLink } = setup();
    const { station, peripheral } = place();
    // Per connection: three stalls (pause), two stalls, a good session, then three stalls again.
    const script: Array<StationOptions['silentFrom']> =
      ['auth-status', 'auth', 'auth-status', 'auth', 'auth-status', undefined, 'auth', 'auth-status', 'auth'];
    peripheral.onConnect = n => { station.opts.silentFrom = script[n - 1]; };
    const stalled = () => links().filter(s => s === 'stalled').length;
    watch();
    // A stalled attempt: the advert after a second, then the session's stage timeout.
    await advance(ADVERT_MS + STAGE_MS);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'searching', detail: 'no reply in auth-status' });
    await advance(BACKOFF_MS[0] + ADVERT_MS + STAGE_MS);
    expect(stalled()).toBe(0);
    await advance(BACKOFF_MS[1] + ADVERT_MS + STAGE_MS);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'stalled', detail: 'no reply in auth-status' });
    await advance(STALL_PAUSE_MS - 1);
    expect(peripheral.connects).toBe(3);

    await until(() => links().at(-1) === 'connected');
    expect(peripheral.connects).toBe(6);
    expect(stalled()).toBe(1);
    peripheral.drop();
    // Without the reset, the first stall after the good session would be the third in a row.
    await until(() => stalled() === 2);
    expect(peripheral.connects).toBe(9);
  });

  it('an unsupported advert is never connected to: R331 prefix, or encrypt type 1', async () => {
    for (const o of [{ sn: 'R331ZEB4XXXX0000', encryptType: 7 }, { sn: SN, encryptType: 1 }]) {
      const { central, host, place, watch, links } = setup();
      const { peripheral } = place(o);
      watch(TOKEN, o.sn);
      await advance(ADVERT_MS);
      expect(links()).toEqual(['searching', 'unsupported']);
      await advance(UNSUPPORTED_RECHECK_MS - 1);
      expect(central.scanStarts).toHaveLength(1);
      await advance(1 + ADVERT_MS);
      expect(links()).toEqual(['searching', 'unsupported', 'searching', 'unsupported']);
      expect(peripheral.connects).toBe(0);
      host.handle({ cmd: 'unwatch' });
    }
  });

  it('ten bad frames drop the link and reconnect', async () => {
    const { place, watch, links, lastLink } = setup();
    const { station, peripheral } = place();
    const garbage = (n: number) => { for (let i = 0; i < n; i++) station.garbage(); };
    watch();
    await advance(ADVERT_MS);
    // Only frames in a row count: a good packet starts the count over.
    garbage(BAD_FRAME_LIMIT - 1);
    station.emit(INV);
    garbage(BAD_FRAME_LIMIT - 1);
    await advance(0);
    expect(links().at(-1)).toBe('connected');
    expect(peripheral.disconnects).toBe(0);
    garbage(1);
    await advance(0);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'lost', detail: '10 bad frames' });
    expect(peripheral.disconnects).toBe(1);
    await advance(BACKOFF_MS[0] - 1);
    expect(peripheral.connects).toBe(1);
    await advance(1 + ADVERT_MS);
    expect(links()).toEqual(['searching', 'connecting', 'connected', 'lost', 'searching', 'connecting', 'connected']);
    expect(peripheral.connects).toBe(2);
  });

  it('a link that carries nothing for 60 s is dropped, and the next try waits the 60 s cap', async () => {
    const { events, place, watch, links, lastLink } = setup();
    const { peripheral } = place();
    watch();
    await advance(ADVERT_MS);
    expect(links().at(-1)).toBe('connected');
    await advance(SILENT_LINK_MS - 1);
    expect(links().at(-1)).toBe('connected');
    expect(peripheral.disconnects).toBe(0);
    await advance(1);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'lost', detail: 'no data for 60 s' });
    expect(peripheral.disconnects).toBe(1);
    expect(events.flatMap(e => (e.ev === 'log' ? [e.text] : [])).at(-1)).toBe('R601… lost (no data for 60 s)');
    // Not BACKOFF_MS[0]: a station that takes the login and then says nothing is not handshaked again every 5 s.
    await advance(BACKOFF_MS[BACKOFF_MS.length - 1] - 1);
    expect(peripheral.connects).toBe(1);
    await advance(1 + ADVERT_MS);
    expect(peripheral.connects).toBe(2);
    expect(links().at(-1)).toBe('connected');
  });

  it('any module keeps the link: PD alone, then ems alone, with the inverter silent throughout', async () => {
    const { place, watch, links, heartbeats } = setup();
    const { station, peripheral } = place();
    const EMS = encodePacket({ src: 0x03, dst: 0x21, cmdSet: 0x20, cmdId: 0x02, payload: Buffer.alloc(40) });
    watch();
    await advance(ADVERT_MS);
    // 130 s of PD every 5 s, then 70 s of ems only (never forwarded, still data).
    for (let i = 0; i < 26; i++) { station.emit(PD); await advance(5_000); }
    for (let i = 0; i < 14; i++) { station.emit(EMS); await advance(5_000); }
    expect(links()).toEqual(['searching', 'connecting', 'connected']);
    expect(peripheral.disconnects).toBe(0);
    expect(heartbeats()).not.toContain('inv');
    // Then nothing: dropped once the last packet is 60 s old, at the next check.
    const lastAt = Date.now() - 5_000;
    await until(() => links().at(-1) === 'lost');
    expect(Date.now() - lastAt).toBeGreaterThanOrEqual(SILENT_LINK_MS);
    expect(Date.now() - lastAt).toBeLessThanOrEqual(SILENT_LINK_MS + 10_000);
  });

  it('ending a connected session stops its silence check: unwatch, suspend, adapter off, disconnect', async () => {
    const ends: Array<[string, (s: ReturnType<typeof setup> & { peripheral: FakePeripheral }) => void, number]> = [
      ['unwatch', s => s.host.handle({ cmd: 'unwatch' }), 0],
      ['suspend', s => s.host.handle({ cmd: 'suspend' }), 0],
      ['adapter off', s => s.central.setState('poweredOff'), 0],
      // Only the backoff is left.
      ['disconnect', s => s.peripheral.drop(), 1],
    ];
    for (const [name, end, left] of ends) {
      const s = setup();
      const { peripheral } = s.place();
      s.watch();
      await advance(ADVERT_MS + 25_000);
      expect(s.links().at(-1), name).toBe('connected');
      // The silence check is the one timer of a connected session.
      expect(vi.getTimerCount(), name).toBe(1);
      end({ ...s, peripheral });
      expect(vi.getTimerCount(), name).toBe(left);
      vi.clearAllTimers();
    }
  });

  it('a new watch mid-session stops the old silence check', async () => {
    const { host, place, watch, links } = setup();
    const { peripheral } = place();
    watch();
    await advance(ADVERT_MS + 25_000);
    watch();
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(2);
    expect(peripheral.disconnects).toBe(1);
    expect(links()).toEqual(['searching', 'connecting', 'connected', 'searching', 'connecting', 'connected']);
    // The new session's check only: the old one (due at 31 s) is gone.
    expect(vi.getTimerCount()).toBe(1);
    host.handle({ cmd: 'unwatch' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suspend disconnects and resume reconnects at once', async () => {
    const { central, host, place, watch, links } = setup();
    watch();
    // Five failed searches: the next wait would be 60 s.
    await advance(5 * SCAN_FIND_MS + 5_000 + 10_000 + 20_000 + 40_000);
    expect(central.scanStarts).toHaveLength(5);
    const { peripheral } = place();
    host.handle({ cmd: 'suspend' });
    expect(central.scanning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    host.handle({ cmd: 'resume' });
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(1);
    expect(links().at(-1)).toBe('connected');

    host.handle({ cmd: 'suspend' });
    expect(peripheral.disconnects).toBe(1);
    expect(links().at(-1)).toBe('lost');
    await advance(10 * 60_000);
    expect(peripheral.connects).toBe(1);
    host.handle({ cmd: 'resume' });
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(2);
    expect(links().at(-1)).toBe('connected');
  });

  it('resume resets the backoff', async () => {
    const { central, host, watch } = setup();
    watch();
    // Five failed searches end at 150 s; the next wait would be 60 s.
    await advance(5 * SCAN_FIND_MS + 5_000 + 10_000 + 20_000 + 40_000);
    host.handle({ cmd: 'suspend' });
    host.handle({ cmd: 'resume' });
    await advance(SCAN_FIND_MS + BACKOFF_MS[0]);
    expect(central.scanStarts.slice(-2)).toEqual([150_000, 150_000 + SCAN_FIND_MS + BACKOFF_MS[0]]);
  });

  it('a new watch restarts at once, even in a refusal pause; unwatch disconnects and posts idle', async () => {
    const { central, host, place, watch, links, lastLink } = setup();
    const { peripheral } = place();
    watch(OTHER_TOKEN);
    await advance(ADVERT_MS);
    expect(links().at(-1)).toBe('refused');
    watch(TOKEN);
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(2);
    expect(links().at(-1)).toBe('connected');

    host.handle({ cmd: 'unwatch' });
    expect(peripheral.disconnects).toBe(2);
    expect(lastLink()).toEqual({ ev: 'link', sn: SN, state: 'idle' });
    expect(central.scanning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a powered-on adapter with no timers running', async () => {
    const { central, events, host, place, watch, links } = setup('unknown');
    const { peripheral } = place();
    watch();
    await advance(60_000);
    expect(central.scanStarts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    central.setState('poweredOn');
    await advance(ADVERT_MS);
    expect(links()).toEqual(['searching', 'connecting', 'connected']);

    central.setState('poweredOff');
    expect(links().at(-1)).toBe('lost');
    expect(peripheral.disconnects).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // With the adapter off a scan cannot run: it answers at once, empty.
    host.handle({ cmd: 'scan', id: 9, ms: 8_000 });
    expect(events.at(-1)).toEqual({ ev: 'scan-result', id: 9, adverts: [] });
    central.setState('poweredOn');
    await advance(ADVERT_MS);
    expect(links().at(-1)).toBe('connected');
    expect(events.flatMap(e => (e.ev === 'adapter' ? [e.state] : []))).toEqual(['unknown', 'poweredOn', 'poweredOff', 'poweredOn']);
  });

  it('a refusal pause outlives an adapter outage', async () => {
    const { central, place, watch, links } = setup();
    const { peripheral } = place();
    watch(OTHER_TOKEN);
    await advance(ADVERT_MS);
    expect(links().at(-1)).toBe('refused');
    central.setState('poweredOff');
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    central.setState('poweredOn');
    await advance(REFUSED_PAUSE_MS - 60_000 - 1);
    expect(peripheral.connects).toBe(1);
    await advance(1 + ADVERT_MS);
    expect(peripheral.connects).toBe(2);
  });
});

describe('BLE host: scan and probe', () => {
  it('scan returns one entry per SN while a watch keeps its own scan', async () => {
    const { central, events, host, place, watch } = setup();
    const A = 'R601AAAA00000001', B = 'R611BBBB00000002';
    place({ sn: A, rssi: -70 });
    place({ sn: B, rssi: -60 });
    watch(TOKEN, SN); // not nearby: the watch keeps searching
    host.handle({ cmd: 'scan', id: 7, ms: 3_000 });
    await advance(ADVERT_MS);
    central.nearby[0].rssi = -55;
    await advance(3_000 - ADVERT_MS);
    expect(events.filter(e => e.ev === 'scan-result')).toEqual([{
      ev: 'scan-result', id: 7, adverts: [
        { sn: A, soc: 87, rssi: -55, encryptType: 7 },
        { sn: B, soc: 87, rssi: -60, encryptType: 7 },
      ],
    }]);
    expect(central.scanStarts).toEqual([0]);
    expect(central.scanning).toBe(true);
    await advance(SCAN_FIND_MS - 3_000);
    expect(central.scanStops).toBe(1);
  });

  it('probe runs the handshake to the auth status on the first EcoFlow advert', async () => {
    const { central, events, host, place } = setup();
    const { station, peripheral } = place();
    host.handle({ cmd: 'probe', id: 3 });
    await advance(ADVERT_MS);
    expect(events.filter(e => e.ev === 'probe-result')).toEqual([
      { ev: 'probe-result', id: 3, ok: true, detail: expect.stringMatching(/^R601… auth-status 00 in \d+ ms$/) },
    ]);
    expect(station.sent).toEqual(['35/89']);
    expect(peripheral.disconnects).toBe(1);

    central.nearby = [];
    host.handle({ cmd: 'probe', id: 4 });
    await advance(SCAN_FIND_MS);
    expect(events.filter(e => e.ev === 'probe-result').at(-1)).toEqual({ ev: 'probe-result', id: 4, ok: false, detail: 'no EcoFlow station found' });
  });

  it('never writes anything the session did not build', async () => {
    const { host, place, watch } = setup();
    const { station, peripheral } = place({ station: { clockRequestFirst: true, heartbeatOnAuth: true } });
    watch();
    await advance(ADVERT_MS);
    // The station's clock request goes unanswered; heartbeats and broken frames are read, never answered.
    station.send({ src: 0x35, dst: 0x21, cmdSet: 0x01, cmdId: 0x52 });
    station.emit(INV);
    station.emit(PD);
    station.emit(MPPT);
    for (let i = 0; i < BAD_FRAME_LIMIT; i++) station.garbage();
    await advance(BACKOFF_MS[0] + ADVERT_MS);
    watch(OTHER_TOKEN);
    await advance(ADVERT_MS);
    host.handle({ cmd: 'probe', id: 1 });
    await advance(ADVERT_MS);
    expect(peripheral.connects).toBe(4);

    const allowed = ['hs/01', 'hs/02', 'packet 35 35/89', 'packet 35 35/86'];
    expect(station.writes.filter(w => !allowed.includes(w))).toEqual([]);
    expect(new Set(station.writes)).toEqual(new Set(allowed));
  });
});
