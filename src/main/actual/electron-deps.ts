import { net, safeStorage } from 'electron';
import { connect } from 'mqtt';
import type { FetchLike } from './ecoflow/api';
import type { MqttConnect } from './ecoflow/source';
import type { Encryptor } from './secrets';

// The only module of actual/ that touches Electron and mqtt.js; everything else gets these injected.

/**
 * Chromium's network stack rather than Node's: the system proxy and certificate store apply. No HTTP cache: a cache
 * validator must never freeze the quota/all body, whose changes are the sign of fresh data.
 */
export const electronFetch: FetchLike = (url, init) => net.fetch(url, { ...init, cache: 'no-store' });

export const electronEncryptor: Encryptor = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: s => safeStorage.encryptString(s),
  decryptString: b => safeStorage.decryptString(b),
};

export const mqttConnect: MqttConnect = (url, opts) => connect(url, opts);
