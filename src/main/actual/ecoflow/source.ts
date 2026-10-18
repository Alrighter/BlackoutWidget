import type { Logger } from '../../log';
import { NetworkError } from '../../providers/types';
import { scrubKeys } from '../secrets';
import type { ActualReading, ActualStateSource } from '../types';
import {
  describeEcoflowError, EcoflowApiError, type EcoflowApiLike, type EcoflowDevice, type EcoflowKeys, type MqttCertificate,
} from './api';
import { normalizeQuotaMessage, parseStatusMessage } from './mqtt-message';
import { OFFLINE_REASON, QuotaTracker, unknownReading } from './quota-tracker';

export { FRESH_MS } from './quota-tracker';
export const QUOTA_POLL_MS = 60_000, DEVICES_POLL_MS = 5 * 60_000, KEY_ERROR_POLL_MS = 15 * 60_000,
  MQTT_AUTH_PAUSE_MS = 30 * 60_000, SESSION_PROOF_MS = 60_000;
export const MQTT_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

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

type Timer = ReturnType<typeof setTimeout>;
type PollKind = 'devices' | 'quota';
interface Poll { every: number; label: string; timer?: Timer; busy: boolean; slow: boolean; error?: unknown }
/** A station-online flag and when it last changed (a repeat of the same value is no news). */
interface Seen { online: boolean; changedAt: number }

/** CONNACK refusals a new certificate may cure: 4/5 bad credentials / not authorized (MQTT 3.1.1), 134/135 (MQTT 5). */
export const AUTH_REFUSED = new Set([4, 5, 134, 135]);

/** Log-safe once scrubbed: the code only, never the message (it can carry the server's own text). */
export function errorCode(err: unknown): string {
  if (err instanceof EcoflowApiError) return err.code;
  if (err instanceof NetworkError) return 'network';
  return err instanceof Error ? err.name : 'unknown';
}

export function errorReason(err: unknown): string {
  if (err instanceof NetworkError) return 'немає з’єднання з EcoFlow';
  if (err instanceof EcoflowApiError) return err.message;
  return describeEcoflowError('bad-json', '');
}

const isKeyProblem = (err: unknown) => err instanceof EcoflowApiError && err.keyProblem;

/**
 * Reads one station: quota/all and the device list over HTTP on timers, plus an MQTT subscription that pushes changes
 * and keeps the cloud cache from freezing. On/off readings carry the time of the last real sign of fresh data.
 */
export class EcoflowSource implements ActualStateSource {
  private readonly now: () => number;
  private onReading: ((r: ActualReading) => void) | undefined;
  private stopped = false;
  private readonly polls: Record<PollKind, Poll> = {
    devices: { every: DEVICES_POLL_MS, label: 'device list', busy: false, slow: false },
    quota: { every: QUOTA_POLL_MS, label: 'quota/all', busy: false, slow: false },
  };

  /** quota/all is the snapshot, the /quota topic the push. */
  private readonly quotas: QuotaTracker;
  private found: boolean | undefined;
  private listed: Seen | undefined;
  private status: Seen | undefined;

  private cert: MqttCertificate | undefined;
  private client: MqttClientLike | undefined;
  private connected = false;
  private statusThisSession = false;
  private attempts = 0;
  private authRetried = false;
  private retryTimer: Timer | undefined;
  private proofTimer: Timer | undefined;

  constructor(
    /** `keys` only scrub server text; the requests themselves are signed by `api`. */
    private readonly cfg: { sn: string; clientId: string; keys: EcoflowKeys },
    private readonly api: EcoflowApiLike,
    private readonly deps: { connect: MqttConnect; log: Logger; now?: () => number },
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.quotas = new QuotaTracker({ log: deps.log, label: 'ecoflow', firstSnapshotFresh: false });
  }

  start(onReading: (r: ActualReading) => void): void {
    this.onReading = onReading;
    this.arm('devices');
    this.arm('quota');
    void this.boot();
  }

  stop(): void {
    this.stopped = true;
    this.onReading = undefined;
    clearInterval(this.polls.devices.timer);
    clearInterval(this.polls.quota.timer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.proofTimer);
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    client?.end(true);
  }

  private async boot(): Promise<void> {
    await this.poll('devices');
    await this.poll('quota');
    if (!this.stopped) await this.connectMqtt();
  }

  private arm(kind: PollKind): void {
    const p = this.polls[kind];
    clearInterval(p.timer);
    p.timer = setInterval(() => void this.poll(kind), p.slow ? KEY_ERROR_POLL_MS : p.every);
  }

  private poll(kind: PollKind): Promise<void> {
    if (kind === 'devices') return this.request('devices', () => this.api.listDevices(), list => this.applyDevices(list));
    return this.request('quota', () => this.api.getQuotaAll(this.cfg.sn), q => {
      // A working quota/all proves the connection and the keys, so a list error is over too; a working list says
      // nothing about quota/all (1006 is per station).
      this.polls.devices.error = undefined;
      this.applyQuota(q);
    });
  }

  /** One request per kind at a time (a tick that finds one in flight is skipped); a result after stop() is dropped. */
  private async request<T>(kind: PollKind, call: () => Promise<T>, apply: (v: T) => void): Promise<void> {
    const p = this.polls[kind];
    if (p.busy || this.stopped) return;
    p.busy = true;
    let result: T;
    try {
      result = await call();
    } catch (err) {
      p.busy = false;
      if (this.stopped) return;
      if (p.error === undefined || errorCode(p.error) !== errorCode(err)) {
        this.deps.log.warn(`ecoflow: ${p.label} failed`, this.safe(errorCode(err)));
      }
      p.error = err;
      this.setSlow(kind, isKeyProblem(err));
      this.evaluate();
      return;
    }
    p.busy = false;
    if (this.stopped) return;
    p.error = undefined;
    apply(result);
    this.setSlow(kind, false);
    this.evaluate();
  }

  private setSlow(kind: PollKind, slow: boolean): void {
    if (this.polls[kind].slow === slow) return;
    this.polls[kind].slow = slow;
    this.arm(kind);
  }

  private applyDevices(list: EcoflowDevice[]): void {
    const d = list.find(x => x.sn === this.cfg.sn);
    this.found = !!d;
    if (d && this.listed?.online !== d.online) this.listed = { online: d.online, changedAt: this.now() };
  }

  private applyQuota(q: Record<string, unknown>): void {
    this.quotas.snapshot(q, this.now());
  }

  private applyMqttQuota(q: Record<string, unknown>): void {
    const now = this.now();
    this.quotas.push(q, now);
    // A station that pushes quotas is online, whatever an older /status said.
    this.status = { online: true, changedAt: now };
    this.sessionProven();
    this.evaluate();
  }

  private applyStatus(online: boolean): void {
    if (this.status?.online !== online) this.status = { online, changedAt: this.now() };
    this.statusThisSession = true;
    this.evaluate();
  }

  /** /status wins while MQTT is up and has sent one (the list lags up to ~15 min); otherwise the latest change wins. */
  private online(): boolean | undefined {
    const { listed, status } = this;
    if (status && ((this.connected && this.statusThisSession) || !listed || status.changedAt >= listed.changedAt)) return status.online;
    return listed?.online;
  }

  /** Server text (an error code or message) can echo the request: the keys never reach a reading or a log line. */
  private safe(text: string): string {
    return scrubKeys(text, this.cfg.keys);
  }

  private evaluate(): void {
    if (this.stopped || !this.onReading) return;
    // A failing consumer must not break the polls (fire-and-forget promises) or mqtt.js's message dispatch.
    try { this.onReading(this.reading(this.now())); } catch (err) { this.deps.log.error('ecoflow: reading handler failed', err); }
  }

  private reading(now: number): ActualReading {
    const err = this.polls.quota.error ?? this.polls.devices.error;
    // Ruling R7: fresh MQTT quotas outrank a failing HTTP side (some models answer 1006 over REST yet push over MQTT);
    // a pure function of the current state, so no unknown/on flip-flop while the error lasts.
    if (err !== undefined && !this.quotas.pushFresh(now)) return unknownReading(now, this.safe(errorReason(err)));
    if (this.found === false) return unknownReading(now, 'станцію не знайдено в акаунті');
    if (this.online() === false) return unknownReading(now, OFFLINE_REASON);
    return this.quotas.reading(now);
  }

  private async connectMqtt(): Promise<void> {
    this.retryTimer = undefined;
    if (!this.cert) {
      try {
        const cert = await this.api.getCertification();
        if (this.stopped) return;
        this.cert = cert;
      } catch (err) {
        if (this.stopped) return;
        this.deps.log.warn('ecoflow: certification failed', this.safe(errorCode(err)));
        // The certificate is HTTP too: with bad keys it waits like the polls do.
        if (isKeyProblem(err)) this.retryTimer = setTimeout(() => void this.connectMqtt(), KEY_ERROR_POLL_MS);
        else this.backoff();
        return;
      }
    }
    const { account, password, host, port } = this.cert;
    let client: MqttClientLike;
    try {
      client = this.deps.connect(`mqtts://${host}:${port}`, {
        clientId: this.cfg.clientId, username: account, password, reconnectPeriod: 0, keepalive: 30, clean: true,
      });
    } catch (err) {
      this.deps.log.warn('ecoflow: mqtt connect failed', err instanceof Error ? err.name : 'unknown');
      this.backoff();
      return;
    }
    this.client = client;
    const quotaTopic = `/open/${account}/${this.cfg.sn}/quota`, statusTopic = `/open/${account}/${this.cfg.sn}/status`;
    client.on('connect', () => {
      if (this.client !== client) return;
      this.connected = true;
      this.statusThisSession = false;
      // Ruling R12: a CONNACK alone resets nothing — a broker that accepts and then drops would loop every 10 s.
      clearTimeout(this.proofTimer);
      this.proofTimer = setTimeout(() => this.sessionProven(), SESSION_PROOF_MS);
      this.deps.log.info('ecoflow: mqtt connected');
      client.subscribe([quotaTopic, statusTopic], { qos: 1 });
    });
    client.on('message', (topic, payload, packet) => {
      // Ruling R18: a retained message is the broker's replay of an old one — no news of the station, ignored entirely.
      if (this.client !== client || packet?.retain) return;
      let msg: unknown;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      if (topic === quotaTopic) {
        const q = normalizeQuotaMessage(msg);
        if (q) this.applyMqttQuota(q);
      } else if (topic === statusTopic) {
        const s = parseStatusMessage(msg);
        if (s !== null) this.applyStatus(s);
      }
    });
    client.on('error', err => this.dropped(client, err));
    client.on('close', () => this.dropped(client));
  }

  /** The first error or close of the current client decides what comes next; its later events are ignored. */
  private dropped(client: MqttClientLike, err?: Error & { code?: number }): void {
    if (this.client !== client) return;
    this.client = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    clearTimeout(this.proofTimer);
    client.end(true);
    if (err) this.deps.log.warn('ecoflow: mqtt error', err.code ?? err.name);
    if (wasConnected) this.deps.log.warn('ecoflow: mqtt closed');
    if (err?.code !== undefined && AUTH_REFUSED.has(err.code)) {
      this.cert = undefined;
      if (!this.authRetried) {
        this.authRetried = true;
        this.deps.log.warn('ecoflow: mqtt not authorized, trying a new certificate');
        void this.connectMqtt();
      } else {
        this.deps.log.warn('ecoflow: mqtt not authorized again, pausing 30 min');
        this.retryTimer = setTimeout(() => void this.connectMqtt(), MQTT_AUTH_PAUSE_MS);
      }
    } else this.backoff();
    // Without MQTT the device list counts for "online" again.
    if (wasConnected) this.evaluate();
  }

  /** The session delivered (a live /quota message, or SESSION_PROOF_MS connected): reconnects start over. */
  private sessionProven(): void {
    clearTimeout(this.proofTimer);
    this.attempts = 0;
    this.authRetried = false;
  }

  private backoff(): void {
    const delay = MQTT_BACKOFF_MS[Math.min(this.attempts, MQTT_BACKOFF_MS.length - 1)];
    this.attempts++;
    this.retryTimer = setTimeout(() => void this.connectMqtt(), delay);
  }
}
