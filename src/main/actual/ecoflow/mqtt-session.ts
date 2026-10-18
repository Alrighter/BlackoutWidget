import type { Logger } from '../../log';
import type { ActualReading } from '../types';
import type { MqttCertificate } from './api';

export const MQTT_AUTH_PAUSE_MS = 30 * 60_000, SESSION_PROOF_MS = 60_000;
export const MQTT_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
/** CONNACK refusals a new certificate may cure: 4/5 bad credentials / not authorized (MQTT 3.1.1), 134/135 (MQTT 5). */
export const AUTH_REFUSED = new Set([4, 5, 134, 135]);

export interface MqttClientLike {
  on(event: 'connect', cb: () => void): void;
  /** mqtt.js passes the PUBLISH packet as the third argument. */
  on(event: 'message', cb: (topic: string, payload: Buffer, packet?: { retain?: boolean }) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error & { code?: number }) => void): void;
  subscribe(topics: string[], opts: { qos: 1 }, cb?: (err: Error | null, granted?: { topic: string; qos: number }[]) => void): void;
  publish(topic: string, payload: string, opts: { qos: 1 }, cb?: (err?: Error) => void): void;
  end(force?: boolean): void;
}
export type MqttConnect = (url: string, opts: {
  clientId: string; username: string; password: string; reconnectPeriod: 0; keepalive: 30; clean: true;
}) => MqttClientLike;

/** Both brokers alike: TLS, clean session, keepalive 30 and no reconnect of mqtt.js's own (the sources pace it). */
export function connectBroker(connect: MqttConnect, cert: MqttCertificate, clientId: string): MqttClientLike {
  return connect(`mqtts://${cert.host}:${cert.port}`, {
    clientId, username: cert.account, password: cert.password, reconnectPeriod: 0, keepalive: 30, clean: true,
  });
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The reconnect pacing both sources share: the MQTT_BACKOFF_MS ladder and the one fresh-credentials retry after a
 * refused CONNACK. Ruling R12: only a proven session (a live push, or SESSION_PROOF_MS connected) starts both over.
 */
export class ReconnectPacer {
  private attempts = 0;
  private authRetried = false;
  private proofTimer: Timer | undefined;

  /** The delay before the next reconnect, one step further up the ladder each time. */
  nextDelay(): number {
    const delay = MQTT_BACKOFF_MS[Math.min(this.attempts, MQTT_BACKOFF_MS.length - 1)];
    this.attempts++;
    return delay;
  }

  /** A CONNACK alone resets nothing — a broker that accepts and then drops would loop every 10 s. */
  connected(): void {
    clearTimeout(this.proofTimer);
    this.proofTimer = setTimeout(() => this.proven(), SESSION_PROOF_MS);
  }

  proven(): void {
    clearTimeout(this.proofTimer);
    this.attempts = 0;
    this.authRetried = false;
  }

  /** The connection is gone, or the source stopped: a pending proof no longer counts. */
  dropped(): void {
    clearTimeout(this.proofTimer);
  }

  /** True once per proven session: a refused CONNACK may try fresh credentials; after that it pauses. */
  takeAuthRetry(): boolean {
    if (this.authRetried) return false;
    this.authRetried = true;
    return true;
  }
}

/** A failing consumer must not break the timers, the promise chains or mqtt.js's message dispatch. */
export function deliverReading(
  onReading: ((r: ActualReading) => void) | undefined, read: () => ActualReading, log: Logger, label: string,
): void {
  if (!onReading) return;
  try { onReading(read()); } catch (err) { log.error(`${label}: reading handler failed`, err); }
}
