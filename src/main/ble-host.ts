import { withBindings, type Characteristic, type Noble, type Peripheral } from '@stoprocent/noble';
import { BleHost, type BleCentral, type BleChannel, type BlePeripheral } from './actual/ecoflow/ble/host';
import type { AdapterState, HostCommand, HostEvent } from './actual/ecoflow/ble/messages';

/**
 * The BLE host: the utilityProcess entry that runs noble and the BLE session away from main (S§2.5). This file only
 * adapts noble to BleCentral/BlePeripheral and relays the parent port; every decision lives in BleHost. It is the
 * only module that imports noble.
 */

const ADAPTER_STATES: ReadonlySet<string> = new Set<AdapterState>(['poweredOn', 'poweredOff', 'unauthorized', 'unsupported', 'unknown', 'resetting']);
const adapterState = (s: string): AdapterState => (ADAPTER_STATES.has(s) ? (s as AdapterState) : 'unknown');

/**
 * A characteristic UUID as the spike compared them: no dashes, lower case, the Bluetooth base stripped and a short
 * UUID without its leading zeros, so Windows' `0002` and the 128-bit form both read `2`.
 */
function shortUuid(uuid: string): string {
  const u = uuid.replace(/-/g, '').toLowerCase();
  if (u.length === 32 && u.endsWith('00001000800000805f9b34fb')) return parseInt(u.slice(0, 8), 16).toString(16);
  return /^[0-9a-f]{4,8}$/.test(u) ? parseInt(u, 16).toString(16) : u;
}

/** Write + notify: EcoFlow's own pair first, else the Nordic UART pair. */
const CHANNELS = [
  { write: '2', notify: '3' },
  { write: '6e400002b5a3f393e0a9e50e24dcca9e', notify: '6e400003b5a3f393e0a9e50e24dcca9e' },
];

/** A scan start or stop that never confirms must not hold up every later one. */
const SCAN_OP_MS = 10_000;
/** A disconnect that never confirms still resolves: the host only needs the station let go of. */
const DISCONNECT_WAIT_MS = 5_000;

const noop = () => {};

function bounded(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(() => { clearTimeout(timer); resolve(); }, e => { clearTimeout(timer); reject(e); });
  });
}

class NoblePeripheral implements BlePeripheral {
  readonly id: string;

  constructor(private readonly p: Peripheral) {
    this.id = p.id;
  }

  /**
   * A connect that WinRT completed after cancelConnect leaves noble thinking the station is connected, and every later
   * connectAsync would reject «Peripheral already connected». That link is let go of first.
   */
  async connect(): Promise<void> {
    if (this.p.state === 'connected') await this.disconnect();
    await this.p.connectAsync();
  }

  cancelConnect(): void {
    try {
      this.p.cancelConnect();
    } catch { /* nothing to cancel */ }
  }

  disconnect(): Promise<void> {
    if (this.p.state === 'disconnected') return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, DISCONNECT_WAIT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      try {
        this.p.disconnectAsync().then(done, done);
      } catch {
        done();
      }
    });
  }

  onceDisconnect(cb: () => void): void {
    this.p.once('disconnect', () => cb());
  }

  async openChannel(onNotify: (data: Buffer) => void): Promise<BleChannel | null> {
    const { characteristics } = await this.p.discoverAllServicesAndCharacteristicsAsync();
    const byUuid = new Map<string, Characteristic>(characteristics.map(c => [shortUuid(c.uuid), c]));
    const pair = CHANNELS.find(c => byUuid.has(c.write) && byUuid.has(c.notify));
    if (!pair) return null;
    const writer = byUuid.get(pair.write)!;
    const notifier = byUuid.get(pair.notify)!;
    const onData = (data: Buffer) => onNotify(data);
    // Listening before the subscribe, so no frame is missed; the listener goes with the connection.
    notifier.on('data', onData);
    this.p.once('disconnect', () => notifier.removeListener('data', onData));
    await notifier.subscribeAsync();
    // With response: each frame of the handshake is acknowledged by the station.
    return { write: data => writer.writeAsync(data, false) };
  }
}

type Advert = Parameters<Parameters<BleCentral['startScan']>[0]>[0];

class NobleCentral implements BleCentral {
  private readonly stateCbs: Array<(s: AdapterState) => void> = [];
  private onAdvert: ((a: Advert) => void) | null = null;
  private readonly wrapped = new WeakMap<Peripheral, NoblePeripheral>();
  /** Starts and stops run one at a time in call order: the host may stop and start back to back without waiting. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly noble: Noble) {
    // Registered before anything reads the state, so no change is missed.
    noble.on('stateChange', s => {
      const state = adapterState(s);
      for (const cb of this.stateCbs) cb(state);
    });
    noble.on('discover', p => this.discover(p));
  }

  get state(): AdapterState {
    return adapterState(this.noble.state);
  }

  onState(cb: (s: AdapterState) => void): void {
    this.stateCbs.push(cb);
  }

  startScan(onAdvert: (a: Advert) => void): Promise<void> {
    this.onAdvert = onAdvert;
    // allowDuplicates: every advert, repeats included, so a scan that joins the running one still sees each station.
    return this.serial(() => this.noble.startScanningAsync([], true));
  }

  stopScan(): Promise<void> {
    this.onAdvert = null;
    return this.serial(() => this.noble.stopScanningAsync());
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => bounded(op(), SCAN_OP_MS));
    this.queue = run.catch(noop);
    return run;
  }

  /** noble's discover events come from the native side, so adverts reach the host asynchronously. */
  private discover(p: Peripheral): void {
    const onAdvert = this.onAdvert;
    if (!onAdvert) return;
    let peripheral = this.wrapped.get(p);
    if (!peripheral) {
      peripheral = new NoblePeripheral(p);
      this.wrapped.set(p, peripheral);
    }
    onAdvert({ peripheral, manufacturerData: p.advertisement?.manufacturerData, rssi: p.rssi });
  }
}

const parent = process.parentPort;
if (!parent) throw new Error('ble-host runs only as an Electron utility process');

const host = new BleHost(new NobleCentral(withBindings('default')), (e: HostEvent) => parent.postMessage(e));
parent.on('message', ({ data }) => {
  if (data && typeof data === 'object' && typeof (data as { cmd?: unknown }).cmd === 'string') host.handle(data as HostCommand);
});
