import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_UNREADY_MS, BleLink, HOST_FAIL_LIMIT, HOST_STABLE_MS, IDLE_STOP_MS, INV_SILENT_MS, RESPAWN_MS, SCAN_GRACE_MS,
  type HostPort, type LinkEvent,
} from '../../../src/main/actual/ecoflow/ble/link';
import type { AdapterState, AdvertView, HostCommand, HostEvent } from '../../../src/main/actual/ecoflow/ble/messages';
import type { ActualLive } from '../../../src/shared/ipc';

const SN = 'R601ZEB4XXXX0000';
const OTHER_SN = 'R601ZEB4YYYY1111';
const TOKEN = '0123456789ABCDEF0123456789ABCDEF';
const WATCH: HostCommand = { cmd: 'watch', sn: SN, token: TOKEN };
const CAP_MS = RESPAWN_MS[RESPAWN_MS.length - 1];

class FakePort implements HostPort {
  posted: HostCommand[] = [];
  killed = false;
  private eventCbs: Array<(e: HostEvent) => void> = [];
  private exitCbs: Array<(code: number) => void> = [];

  post(cmd: HostCommand): void { this.posted.push(cmd); }
  onEvent(cb: (e: HostEvent) => void): void { this.eventCbs.push(cb); }
  onExit(cb: (code: number) => void): void { this.exitCbs.push(cb); }

  /** Like Electron, the exit of a killed process is reported afterwards. */
  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.exit(0));
  }

  emit(e: HostEvent): void { for (const cb of this.eventCbs) cb(e); }
  exit(code = 1): void { for (const cb of this.exitCbs) cb(code); }

  scans(): Array<Extract<HostCommand, { cmd: 'scan' }>> {
    return this.posted.flatMap(c => (c.cmd === 'scan' ? [c] : []));
  }
}

function setup(o: { spawnThrows?: () => boolean } = {}) {
  const ports: FakePort[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const link = new BleLink({
    spawn: () => {
      if (o.spawnThrows?.()) throw new Error('utilityProcess.fork failed');
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    log,
  });
  const events: LinkEvent[] = [];
  link.onEvent(e => events.push(e));
  const lives: Array<ActualLive | null> = [];
  link.onLive(l => lives.push(l));
  /** The newest host. */
  const port = () => ports[ports.length - 1];
  const adapter = (state: AdapterState) => port().emit({ ev: 'adapter', state });
  const linkTo = (state: Extract<HostEvent, { ev: 'link' }>['state'], sn = SN) => port().emit({ ev: 'link', sn, state });
  const beat = (module: 'inv' | 'pd' | 'mppt', fields: Record<string, number | string>, sn = SN) =>
    port().emit({ ev: 'heartbeat', sn, module, fields });
  const failedCount = () => events.filter(e => e.ev === 'host-failed').length;
  return { link, ports, port, log, events, lives, adapter, linkTo, beat, failedCount };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

// queueMicrotask stays real: the fake host reports a kill's exit through it.
beforeEach(() => vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('BLE link: supervising the host', () => {
  it('spawns lazily and replays the watch after a crash', async () => {
    const { link, ports, port, adapter } = setup();
    expect(ports).toHaveLength(0);

    link.watch(SN, TOKEN);
    expect(ports).toHaveLength(1);
    expect(port().posted).toEqual([WATCH]);
    adapter('poweredOn');

    ports[0].exit(1);
    await advance(RESPAWN_MS[0] - 1);
    expect(ports).toHaveLength(1);
    await advance(1);
    expect(ports).toHaveLength(2);
    expect(ports[1].posted).toEqual([WATCH]);

    // A second crash in a row waits longer; the dead host's late events change nothing.
    adapter('poweredOn');
    ports[1].exit(1);
    ports[0].emit({ ev: 'link', sn: SN, state: 'connected' });
    ports[1].emit({ ev: 'link', sn: SN, state: 'connected' });
    expect(link.connectedSn()).toBeNull();
    await advance(RESPAWN_MS[1] - 1);
    expect(ports).toHaveLength(2);
    await advance(1);
    expect(ports).toHaveLength(3);
    expect(ports[2].posted).toEqual([WATCH]);

    // Suspended: a new host hears suspend before the watch, so it does not connect while the system sleeps.
    adapter('poweredOn');
    link.suspend();
    expect(ports[2].posted.at(-1)).toEqual({ cmd: 'suspend' });
    ports[2].exit(1);
    await advance(RESPAWN_MS[2]);
    expect(ports).toHaveLength(4);
    expect(ports[3].posted).toEqual([{ cmd: 'suspend' }, WATCH]);
    link.resume();
    expect(ports[3].posted.at(-1)).toEqual({ cmd: 'resume' });
  });

  it('a host that ran for a minute before it crashed starts the backoff over', async () => {
    const { link, ports, adapter } = setup();
    link.watch(SN, TOKEN);
    adapter('poweredOn');
    ports[0].exit(1);
    await advance(RESPAWN_MS[0]);
    adapter('poweredOn');
    ports[1].exit(1);
    await advance(RESPAWN_MS[1]);
    adapter('poweredOn');
    await advance(HOST_STABLE_MS);
    ports[2].exit(1);
    await advance(RESPAWN_MS[0] - 1);
    expect(ports).toHaveLength(3);
    await advance(1);
    expect(ports).toHaveLength(4);
  });

  it('three hosts dying before reporting the adapter emit host-failed and keep retrying', async () => {
    const { link, ports, adapter, events, failedCount, lives } = setup();
    link.watch(SN, TOKEN);
    for (let i = 0; i < HOST_FAIL_LIMIT - 1; i++) {
      ports[i].exit(1);
      await advance(RESPAWN_MS[i]);
      expect(ports).toHaveLength(i + 2);
    }
    expect(failedCount()).toBe(0);
    expect(link.getLive()).toEqual({ link: 'searching' });

    ports[HOST_FAIL_LIMIT - 1].exit(1);
    expect(failedCount()).toBe(1);
    expect(events.at(-1)).toEqual({ ev: 'host-failed' });
    expect(link.getLive()).toEqual({ link: 'host-failed' });
    expect(lives.at(-1)).toEqual({ link: 'host-failed' });
    await expect(link.scan(8_000)).resolves.toEqual({ adverts: [], problem: 'host-failed' });

    // Retries go on, at the cap from now on, and each new host still gets the watch.
    for (let i = HOST_FAIL_LIMIT; i < HOST_FAIL_LIMIT + 2; i++) {
      await advance(CAP_MS - 1);
      expect(ports).toHaveLength(i);
      await advance(1);
      expect(ports).toHaveLength(i + 1);
      expect(ports[i].posted).toEqual([WATCH]);
      if (i < HOST_FAIL_LIMIT + 1) ports[i].exit(1);
    }
    expect(failedCount()).toBe(1);

    // A host that reports the adapter ends the failure.
    adapter('poweredOn');
    expect(link.getLive()).toEqual({ link: 'searching' });
    expect(lives.at(-1)).toEqual({ link: 'searching' });
  });

  it('adapterState and hostFailed expose what the link has seen', async () => {
    const { link, ports, adapter } = setup();
    expect(link.adapterState()).toBeNull();
    expect(link.hostFailed()).toBe(false);
    link.watch(SN, TOKEN);
    adapter('poweredOff');
    expect(link.adapterState()).toBe('poweredOff');
    adapter('poweredOn');
    expect(link.adapterState()).toBe('poweredOn');
    // Three hosts in a row die before reporting an adapter.
    ports[0].exit(1);
    for (let i = 1; i < HOST_FAIL_LIMIT + 1; i++) {
      await advance(CAP_MS);
      if (i < HOST_FAIL_LIMIT + 1) ports[i].exit(1);
    }
    expect(link.hostFailed()).toBe(true);
    await advance(CAP_MS);
    adapter('unknown');
    expect(link.hostFailed()).toBe(true);
    adapter('poweredOn');
    expect(link.hostFailed()).toBe(false);
  });

  it('hosts that only ever report an unknown adapter count as dying before the adapter', async () => {
    const { link, ports, adapter, failedCount, lives } = setup();
    link.watch(SN, TOKEN);
    for (let i = 0; i < HOST_FAIL_LIMIT; i++) {
      // BleHost posts this from its constructor, before noble's bindings have started; then the binding dies.
      adapter('unknown');
      ports[i].exit(1);
      if (i < HOST_FAIL_LIMIT - 1) await advance(RESPAWN_MS[i]);
    }
    expect(failedCount()).toBe(1);
    expect(link.getLive()).toEqual({ link: 'host-failed' });

    // Failed: a new host's initial unknown does not end the failure, even for a moment; a real state does.
    await advance(CAP_MS);
    expect(ports).toHaveLength(HOST_FAIL_LIMIT + 1);
    const count = lives.length;
    adapter('unknown');
    expect(link.getLive()).toEqual({ link: 'host-failed' });
    expect(lives).toHaveLength(count);
    await expect(link.scan(8_000)).resolves.toEqual({ adverts: [], problem: 'host-failed' });
    adapter('poweredOff');
    expect(link.getLive()).toEqual({ link: 'bt-off' });
  });

  it('a spawn that throws counts as a host that died before the adapter', async () => {
    let throwing = true;
    const { link, ports, failedCount, log } = setup({ spawnThrows: () => throwing });
    link.watch(SN, TOKEN);
    expect(ports).toHaveLength(0);
    await advance(RESPAWN_MS[0] + RESPAWN_MS[1]);
    expect(failedCount()).toBe(1);
    expect(log.error).toHaveBeenCalled();
    throwing = false;
    await advance(CAP_MS);
    expect(ports).toHaveLength(1);
    expect(ports[0].posted).toEqual([WATCH]);
  });

  it('after host-failed with nothing watched, a scan answers at once and starts one more host', async () => {
    const { link, ports, adapter } = setup();
    for (let i = 0; i < HOST_FAIL_LIMIT; i++) {
      const scan = link.scan(8_000);
      expect(ports).toHaveLength(i + 1);
      ports[i].exit(1);
      // The scan pending at the death that fails the host already names that failure.
      const problem = i === HOST_FAIL_LIMIT - 1 ? 'host-failed' : 'scan-failed';
      await expect(scan).resolves.toEqual({ adverts: [], problem });
      // Nothing is watched: no respawn.
      await advance(CAP_MS);
      expect(ports).toHaveLength(i + 1);
    }
    await expect(link.scan(8_000)).resolves.toEqual({ adverts: [], problem: 'host-failed' });
    expect(ports).toHaveLength(HOST_FAIL_LIMIT + 1);
    expect(ports[HOST_FAIL_LIMIT].posted).toEqual([]);
    adapter('poweredOn');
    const scan = link.scan(8_000);
    const [cmd] = ports[HOST_FAIL_LIMIT].scans();
    ports[HOST_FAIL_LIMIT].emit({ ev: 'scan-result', id: cmd.id, adverts: [] });
    await expect(scan).resolves.toEqual({ adverts: [] });
  });

  it('stops an idle host after 60 s without respawning it', async () => {
    const { link, ports, adapter, log } = setup();
    const scan = link.scan(8_000);
    expect(ports).toHaveLength(1);
    adapter('poweredOn');
    const [cmd] = ports[0].scans();
    ports[0].emit({ ev: 'scan-result', id: cmd.id, adverts: [] });
    await scan;

    await advance(IDLE_STOP_MS - 1);
    expect(ports[0].killed).toBe(false);
    await advance(1);
    expect(ports[0].killed).toBe(true);
    await advance(CAP_MS * 3);
    expect(ports).toHaveLength(1);

    // A watched station keeps its host however long; the unwatch starts the idle count.
    link.watch(SN, TOKEN);
    expect(ports).toHaveLength(2);
    expect(ports[1].posted).toEqual([WATCH]);
    await advance(IDLE_STOP_MS * 2);
    expect(ports[1].killed).toBe(false);
    link.unwatch();
    expect(ports[1].posted.at(-1)).toEqual({ cmd: 'unwatch' });
    await advance(IDLE_STOP_MS - 1);
    expect(ports[1].killed).toBe(false);
    await advance(1);
    expect(ports[1].killed).toBe(true);
    await advance(CAP_MS * 3);
    expect(ports).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    // An idle stop is no crash: nothing logged as one.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('suspend and resume reach a running host; none is spawned for them', () => {
    const { link, ports } = setup();
    link.suspend();
    link.resume();
    expect(ports).toHaveLength(0);
    link.watch(SN, TOKEN);
    link.suspend();
    link.resume();
    expect(ports[0].posted).toEqual([WATCH, { cmd: 'suspend' }, { cmd: 'resume' }]);
  });

  it('dispose kills the host, settles a pending scan and never spawns again', async () => {
    const { link, ports, lives } = setup();
    link.watch(SN, TOKEN);
    const scan = link.scan(8_000);
    const livesBefore = lives.length;
    link.dispose();
    expect(ports[0].killed).toBe(true);
    await expect(scan).resolves.toEqual({ adverts: [], problem: 'scan-failed' });
    await advance(CAP_MS * 3);
    link.watch(SN, TOKEN);
    await expect(link.scan(8_000)).resolves.toEqual({ adverts: [], problem: 'scan-failed' });
    expect(ports).toHaveLength(1);
    expect(link.getLive()).toBeNull();
    // Quitting: listeners are not called any more (a window may be gone).
    expect(lives).toHaveLength(livesBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('log events go to the logger at their level', () => {
    const { link, port, log } = setup();
    link.watch(SN, TOKEN);
    port().emit({ ev: 'log', level: 'info', text: 'R601… searching' });
    port().emit({ ev: 'log', level: 'warn', text: 'R601… lost (disconnected)' });
    port().emit({ ev: 'log', level: 'error', text: 'scan did not start' });
    expect(log.info).toHaveBeenCalledWith('R601… searching');
    expect(log.warn).toHaveBeenCalledWith('R601… lost (disconnected)');
    expect(log.error).toHaveBeenCalledWith('scan did not start');
    // Nothing main logs on its own carries the SN or the token.
    const all = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(all).not.toContain(SN);
    expect(all).not.toContain(TOKEN);
  });
});

describe('BLE link: scans', () => {
  it('scan resolves with adverts, with the adapter problem, or scan-failed on timeout or exit', async () => {
    const { link, ports, port, adapter } = setup();
    const advert: AdvertView = { sn: SN, soc: 87, rssi: -60, encryptType: 7 };
    const answer = (id: number, adverts: AdvertView[] = []) => port().emit({ ev: 'scan-result', id, adverts });
    const lastId = () => port().scans().at(-1)!.id;

    const first = link.scan(8_000);
    expect(port().scans()).toEqual([{ cmd: 'scan', id: expect.any(Number), ms: 8_000 }]);
    adapter('poweredOn');
    answer(lastId(), [advert]);
    await expect(first).resolves.toStrictEqual({ adverts: [advert] });

    // Two at once: each gets its own answer.
    const a = link.scan(8_000);
    const idA = lastId();
    const b = link.scan(3_000);
    const idB = lastId();
    expect(idB).not.toBe(idA);
    answer(idB, []);
    answer(idA, [advert]);
    await expect(a).resolves.toEqual({ adverts: [advert] });
    await expect(b).resolves.toEqual({ adverts: [] });

    const problems: Array<[AdapterState, string]> = [
      ['poweredOff', 'bt-off'], ['unauthorized', 'bt-denied'], ['unsupported', 'bt-missing'],
      ['unknown', 'bt-unavailable'], ['resetting', 'bt-unavailable'],
    ];
    for (const [state, problem] of problems) {
      adapter(state);
      const p = link.scan(8_000);
      answer(lastId());
      await expect(p).resolves.toEqual({ adverts: [], problem });
    }
    adapter('poweredOn');

    // No answer: scan-failed once ms + grace has passed; a late answer changes nothing.
    const late = link.scan(8_000);
    const lateId = lastId();
    let settled = false;
    void late.then(() => { settled = true; });
    await advance(8_000 + SCAN_GRACE_MS - 1);
    expect(settled).toBe(false);
    await advance(1);
    await expect(late).resolves.toEqual({ adverts: [], problem: 'scan-failed' });
    answer(lateId, [advert]);

    // The host exits mid-scan.
    const cut = link.scan(8_000);
    ports[0].exit(1);
    await expect(cut).resolves.toEqual({ adverts: [], problem: 'scan-failed' });
  });

  it('a scan while a respawn is pending is posted to the new host', async () => {
    const { link, ports, adapter } = setup();
    link.watch(SN, TOKEN);
    adapter('poweredOn');
    ports[0].exit(1);
    const scan = link.scan(4_000);
    expect(ports).toHaveLength(1);
    await advance(RESPAWN_MS[0]);
    expect(ports[1].posted).toEqual([WATCH, { cmd: 'scan', id: expect.any(Number), ms: 4_000 }]);
    adapter('poweredOn');
    ports[1].emit({ ev: 'scan-result', id: ports[1].scans()[0].id, adverts: [] });
    await expect(scan).resolves.toEqual({ adverts: [] });
  });
});

describe('BLE link: the watched station', () => {
  it('connectedSn follows the link state', async () => {
    const { link, ports, adapter, linkTo, events } = setup();
    expect(link.connectedSn()).toBeNull();
    link.watch(SN, TOKEN);
    adapter('poweredOn');
    expect(link.connectedSn()).toBeNull();
    linkTo('connecting');
    expect(link.connectedSn()).toBeNull();
    linkTo('connected');
    expect(link.connectedSn()).toBe(SN);
    // Another station's events are not ours.
    linkTo('lost', OTHER_SN);
    expect(link.connectedSn()).toBe(SN);
    linkTo('lost');
    expect(link.connectedSn()).toBeNull();
    linkTo('connected');
    expect(link.connectedSn()).toBe(SN);

    // The host dies: the link is gone with it, and subscribers hear it.
    ports[0].exit(1);
    expect(link.connectedSn()).toBeNull();
    expect(events.at(-1)).toEqual({ ev: 'link', sn: SN, state: 'lost', detail: 'host exited' });
    await advance(RESPAWN_MS[0]);
    adapter('poweredOn');
    linkTo('connected');
    expect(link.connectedSn()).toBe(SN);

    link.unwatch();
    expect(link.connectedSn()).toBeNull();
  });

  it('forwards the host events to subscribers until they unsubscribe', () => {
    const { link, port } = setup();
    const seen: LinkEvent[] = [];
    const off = link.onEvent(e => seen.push(e));
    link.watch(SN, TOKEN);
    const beat: HostEvent = { ev: 'heartbeat', sn: SN, module: 'inv', fields: { acInVol: 229_600 } };
    port().emit(beat);
    off();
    port().emit({ ev: 'adapter', state: 'poweredOn' });
    expect(seen).toEqual([beat]);
  });

  it('live: volts rounded from mV, acOut from MPPT before the inverter, values cleared on lost', () => {
    const { link, adapter, linkTo, beat, lives } = setup();
    expect(link.getLive()).toBeNull();
    link.watch(SN, TOKEN);
    expect(link.getLive()).toEqual({ link: 'searching' });
    adapter('poweredOn');
    linkTo('connecting');
    expect(link.getLive()).toEqual({ link: 'connecting' });
    linkTo('connected');
    expect(link.getLive()).toStrictEqual({ link: 'connected', invSilent: false });

    // A short inverter heartbeat: what it carries, nothing more (no acOut it never sent).
    beat('inv', { acInVol: 229_600, acInFreq: 50, inputWatts: 0 });
    expect(link.getLive()).toStrictEqual({ link: 'connected', acInVolts: 230, acInHz: 50, inputWatts: 0, invSilent: false });
    beat('inv', { acInVol: 229_400, acInFreq: 50, inputWatts: 12, cfgAcEnabled: 0 });
    expect(link.getLive()).toMatchObject({ acInVolts: 229, inputWatts: 12, acOut: false });
    beat('mppt', { cfgAcEnabled: 1 });
    expect(link.getLive()).toMatchObject({ acOut: true });
    beat('inv', { acInVol: 229_400, acInFreq: 50, inputWatts: 12, cfgAcEnabled: 0 });
    expect(link.getLive()).toMatchObject({ acOut: true });
    beat('pd', { soc: 87 });
    expect(link.getLive()).toStrictEqual({
      link: 'connected', acInVolts: 229, acInHz: 50, inputWatts: 12, acOut: true, soc: 87, invSilent: false,
    });

    // onLive fires on a change only; another station's heartbeat is not ours.
    const count = lives.length;
    beat('pd', { soc: 87 });
    beat('pd', { soc: 12 }, OTHER_SN);
    expect(lives).toHaveLength(count);
    beat('pd', { soc: 88 });
    expect(lives).toHaveLength(count + 1);
    expect(lives.at(-1)).toMatchObject({ soc: 88 });

    linkTo('lost');
    expect(link.getLive()).toStrictEqual({ link: 'searching' });
    expect(lives.at(-1)).toStrictEqual({ link: 'searching' });
    linkTo('connected');
    expect(link.getLive()).toStrictEqual({ link: 'connected', invSilent: false });

    linkTo('refused');
    expect(link.getLive()).toEqual({ link: 'refused' });
    linkTo('idle');
    expect(link.getLive()).toEqual({ link: 'searching' });

    link.unwatch();
    expect(link.getLive()).toBeNull();
    expect(lives.at(-1)).toBeNull();
  });

  it('live: invSilent after 20 s without an inverter heartbeat', async () => {
    const { link, adapter, linkTo, beat } = setup();
    link.watch(SN, TOKEN);
    adapter('poweredOn');
    linkTo('connected');

    await advance(INV_SILENT_MS - 1);
    expect(link.getLive()?.invSilent).toBe(false);
    await advance(1);
    expect(link.getLive()?.invSilent).toBe(true);

    // A heartbeat ends the silence at once; the next one is counted from it (checked every 5 s).
    beat('inv', { acInVol: 229_600, acInFreq: 50, inputWatts: 0 });
    expect(link.getLive()?.invSilent).toBe(false);
    await advance(2_000);
    beat('inv', { acInVol: 229_600, acInFreq: 50, inputWatts: 0 });
    // Heard at 22 s: silent from 42 s, seen by the check at 45 s.
    await advance(45_000 - 22_000 - 1);
    expect(link.getLive()?.invSilent).toBe(false);
    await advance(1);
    expect(link.getLive()?.invSilent).toBe(true);

    // Leaving connected stops the check.
    linkTo('lost');
    expect(link.getLive()).toStrictEqual({ link: 'searching' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('live: an unknown adapter reads searching for 10 s, then bt-unavailable', async () => {
    const { link, adapter, linkTo } = setup();
    link.watch(SN, TOKEN);
    adapter('unknown');
    expect(link.getLive()).toEqual({ link: 'searching' });
    await advance(ADAPTER_UNREADY_MS - 1);
    expect(link.getLive()).toEqual({ link: 'searching' });
    await advance(1);
    expect(link.getLive()).toEqual({ link: 'bt-unavailable' });
    // resetting is just as unready: no fresh grace.
    adapter('resetting');
    expect(link.getLive()).toEqual({ link: 'bt-unavailable' });

    adapter('poweredOn');
    expect(link.getLive()).toEqual({ link: 'searching' });
    adapter('resetting');
    expect(link.getLive()).toEqual({ link: 'searching' });
    await advance(ADAPTER_UNREADY_MS);
    expect(link.getLive()).toEqual({ link: 'bt-unavailable' });

    // The other problems show at once.
    adapter('poweredOff');
    expect(link.getLive()).toEqual({ link: 'bt-off' });
    adapter('unauthorized');
    expect(link.getLive()).toEqual({ link: 'bt-denied' });
    adapter('unsupported');
    expect(link.getLive()).toEqual({ link: 'bt-missing' });

    adapter('poweredOn');
    linkTo('connected');
    expect(link.getLive()).toEqual({ link: 'connected', invSilent: false });
  });
});
