import { join } from 'node:path';
import { net, safeStorage, utilityProcess } from 'electron';
import { connect } from 'mqtt';
import type { FetchLike } from './ecoflow/api';
import type { HostPort } from './ecoflow/ble/link';
import type { HostCommand, HostEvent } from './ecoflow/ble/messages';
import type { MqttConnect } from './ecoflow/source';
import type { Encryptor } from './secrets';

// The only module of actual/ that touches Electron and mqtt.js; everything else gets these injected.

/**
 * Chromium's network stack rather than Node's: the system proxy and certificate store apply. No HTTP cache: a cache
 * validator must never freeze the quota/all body, whose changes are the sign of fresh data.
 */
export const electronFetch: FetchLike = (url, init) => net.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, cache: 'no-store' });

export const electronEncryptor: Encryptor = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: s => safeStorage.encryptString(s),
  decryptString: b => safeStorage.decryptString(b),
};

export const mqttConnect: MqttConnect = (url, opts) => connect(url, opts);

/**
 * The BLE host as a utilityProcess, so noble never runs in main. `__dirname` is out/main at runtime: this module lands
 * in a shared chunk that the build keeps in out/main, next to ble-host.js. Commands wait for the spawn, and a post to
 * a host that is gone is dropped: its exit is on the way.
 */
export function spawnBleHost(): HostPort {
  const child = utilityProcess.fork(join(__dirname, 'ble-host.js'), [], { serviceName: 'Blackout Widget Bluetooth' });
  const send = (cmd: HostCommand) => {
    try {
      child.postMessage(cmd);
    } catch { /* gone */ }
  };
  let early: HostCommand[] | null = [];
  child.once('spawn', () => {
    const queued = early ?? [];
    early = null;
    for (const cmd of queued) send(cmd);
  });
  return {
    post: cmd => { if (early) early.push(cmd); else send(cmd); },
    onEvent: cb => { child.on('message', (e: HostEvent) => cb(e)); },
    onExit: cb => { child.on('exit', code => cb(code)); },
    kill: () => { child.kill(); },
  };
}
