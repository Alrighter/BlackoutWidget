import type { Logger } from '../../log';
import { NetworkError } from '../../providers/types';
import { scrubSecrets } from '../secrets';
import type { ActualReading, ActualStateSource } from '../types';
import { EcoflowApiError, type MqttCertificate } from './api';
import type { AppAccount, AppSession, EcoflowAppApiLike } from './app-api';
import { isProtobufPayload, latestQuotasRequest, normalizeQuotaMessage, parseGetReply } from './mqtt-message';
import { OFFLINE_REASON, QuotaTracker, unknownReading } from './quota-tracker';
import {
  AUTH_REFUSED, errorCode, errorReason, MQTT_AUTH_PAUSE_MS, MQTT_BACKOFF_MS, SESSION_PROOF_MS, type MqttClientLike, type MqttConnect,
} from './source';

/** The latestQuotas cadence (R§3.7, §7): every 5 min, or every 2 min when snapshots are the only data. */
export const GET_MS = 300_000, GET_REFUSED_MS = 120_000;
/** A rejected login waits long (R§7): the account must never look like it is under a password attack. */
export const LOGIN_RETRY_MS = [30 * 60_000, 60 * 60_000, 120 * 60_000];
export const APP_UNSUPPORTED_REASON = 'Ця модель EcoFlow поки не підтримується входом через акаунт';
/** Connected, yet not one message of the station by the first watchdog (a protobuf model ignores the JSON request). */
export const APP_NO_DATA_REASON = 'EcoFlow не надсилає даних цієї станції — можливо, модель не підтримується входом через акаунт';

export interface AppTopics { property: string; reply: string; get: string }

/** The read-only set (R§3.4): the push topic, the snapshot reply and the snapshot request; never `/set`. */
export function appTopics(userId: string, sn: string): AppTopics {
  return {
    property: `/app/device/property/${sn}`,
    reply: `/app/${userId}/${sn}/thing/property/get_reply`,
    get: `/app/${userId}/${sn}/thing/property/get`,
  };
}

/** The broker takes only `ANDROID_<random>_<userId>` (R§3.2). Like the topics it holds the userId, so it is never logged. */
export const appClientId = (uuid: string, userId: string) => `ANDROID_${uuid}_${userId}`;

type Timer = ReturnType<typeof setTimeout>;
type Granted = { topic: string; qos: number }[];
interface Link { userId: string; cert: MqttCertificate }

/** mqtt.js v5 reports a SUBACK 128 as an error; a granted QoS 128 is checked as well (R§3.5). */
const refused = (err: Error | null, granted?: Granted) => !!err || !!granted?.some(g => g.qos === 128);

/** Transport trouble retries on the MQTT backoff, as on the keys path; an answer from EcoFlow itself (a code, a 4xx) is a rejection. */
function transient(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof EcoflowApiError && (err.code === 'timeout' || err.code === 'bad-json' || /^http-5\d\d$/.test(err.code));
}

/**
 * Reads one station over the EcoFlow app broker after an account login. The property topic pushes changes; a
 * `latestQuotas` request on a timer brings snapshots, which are the only data when the broker refuses the property
 * topic. Logs in once, and again only when the broker refuses the credentials (R§7).
 */
export class EcoflowAppSource implements ActualStateSource {
  private readonly now: () => number;
  private onReading: ((r: ActualReading) => void) | undefined;
  private stopped = false;
  /** The get_reply quotaMap is the snapshot, the property topic the push. Kept across reconnects and logins. */
  private readonly quotas: QuotaTracker;
  /** Everything a server text or a log line must never show. */
  private readonly secrets = new Set<string>();
  private online: boolean | undefined;
  private protobuf = false;
  /** Any push, snapshot answer or protobuf frame of the station so far. */
  private heard = false;
  /** The watchdog fired before anything was heard. */
  private silentStall = false;
  private signInError: unknown;
  /** `step code` of the last failure: one log line per kind of failure, not per retry. */
  private lastFailure: string | undefined;
  private loginFailures = 0;
  /** A login whose certification failed on transport: the retry certifies with it instead of logging in again. */
  private pendingSession: AppSession | undefined;

  private link: Link | undefined;
  private client: MqttClientLike | undefined;
  private topics: AppTopics | undefined;
  private connected = false;
  private propertyRefused = false;
  /** The watchdog has already reconnected for the current silence; fresh data arms it again. */
  private stallRetried = false;
  private attempts = 0;
  private authRetried = false;
  private retryTimer: Timer | undefined;
  private proofTimer: Timer | undefined;
  private getTimer: Timer | undefined;
  private stallTimer: Timer | undefined;

  constructor(
    /** `account` only scrubs server text; the requests themselves go through `api`. */
    private readonly cfg: { sn: string; clientUuid: string; account: AppAccount },
    private readonly api: EcoflowAppApiLike,
    private readonly deps: { connect: MqttConnect; log: Logger; now?: () => number },
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.quotas = new QuotaTracker({ log: deps.log, label: 'ecoflow-app', firstSnapshotFresh: true });
    const { email, password } = cfg.account;
    for (const s of [email, password, Buffer.from(password, 'utf8').toString('base64')]) this.secrets.add(s);
  }

  start(onReading: (r: ActualReading) => void): void {
    this.onReading = onReading;
    void this.connectMqtt();
  }

  stop(): void {
    this.stopped = true;
    this.onReading = undefined;
    clearTimeout(this.retryTimer);
    this.endSession();
  }

  private async connectMqtt(): Promise<void> {
    this.retryTimer = undefined;
    const link = this.link ?? await this.signIn();
    if (!link) return;
    const { userId, cert } = link;
    let client: MqttClientLike;
    try {
      client = this.deps.connect(`mqtts://${cert.host}:${cert.port}`, {
        clientId: appClientId(this.cfg.clientUuid, userId), username: cert.account, password: cert.password,
        reconnectPeriod: 0, keepalive: 30, clean: true,
      });
    } catch (err) {
      this.deps.log.warn('ecoflow-app: mqtt connect failed', err instanceof Error ? err.name : 'unknown');
      this.backoff();
      return;
    }
    this.client = client;
    const topics = this.topics = appTopics(userId, this.cfg.sn);
    client.on('connect', () => {
      if (this.client !== client) return;
      this.connected = true;
      this.propertyRefused = false;
      // Ruling R12: a CONNACK alone resets nothing — a broker that accepts and then drops would loop every 10 s.
      clearTimeout(this.proofTimer);
      this.proofTimer = setTimeout(() => this.sessionProven(), SESSION_PROOF_MS);
      this.deps.log.info('ecoflow-app: mqtt connected');
      // One topic per call, so a refusal hits that topic alone; the request goes out without waiting for either SUBACK.
      client.subscribe([topics.property], { qos: 1 }, (err, granted) => {
        if (this.client !== client || !refused(err, granted)) return;
        this.deps.log.warn('ecoflow-app: property topic refused');
        this.propertyRefused = true;
        this.armGet();
        this.armStall();
      });
      client.subscribe([topics.reply], { qos: 1 }, (err, granted) => {
        if (this.client === client && refused(err, granted)) this.deps.log.warn('ecoflow-app: snapshot topic refused');
      });
      this.requestSnapshot();
      this.armStall();
    });
    client.on('message', (topic, payload, packet) => {
      // Ruling R18: a retained message is the broker's replay of an old one — no news of the station, ignored entirely.
      if (this.client !== client || packet?.retain || (topic !== topics.property && topic !== topics.reply)) return;
      if (isProtobufPayload(payload)) {
        this.applyProtobuf();
        return;
      }
      const msg: unknown = JSON.parse(payload.toString('utf8'));
      if (topic === topics.property) {
        const q = normalizeQuotaMessage(msg);
        if (q) this.applyPush(q);
      } else {
        const r = parseGetReply(msg);
        if (r) this.applyReply(r);
      }
    });
    client.on('error', err => this.dropped(client, err));
    client.on('close', () => this.dropped(client));
  }

  /** One login plus certification. A failure shows its reason and schedules the retry. */
  private async signIn(): Promise<Link | undefined> {
    let step = 'login';
    let session: AppSession | undefined;
    try {
      session = this.pendingSession ?? await this.api.login();
      if (this.stopped) return undefined;
      this.secrets.add(session.token).add(session.userId);
      step = 'certification';
      const cert = await this.api.getCertification(session);
      if (this.stopped) return undefined;
      this.secrets.add(cert.password);
      this.link = { userId: session.userId, cert };
      this.pendingSession = undefined;
    } catch (err) {
      if (this.stopped) return undefined;
      // A rejected certification may mean a bad token: the slow retry logs in afresh.
      this.pendingSession = step === 'certification' && transient(err) ? session : undefined;
      const failure = `${step} ${errorCode(err)}`;
      if (failure !== this.lastFailure) this.deps.log.warn(`ecoflow-app: ${step} failed`, this.safe(errorCode(err)));
      this.lastFailure = failure;
      this.signInError = err;
      // `keyProblem` is not consulted: the login has its own slow schedule, and a 2026 is never final (R§1.5).
      if (transient(err)) this.backoff();
      else {
        const delay = LOGIN_RETRY_MS[Math.min(this.loginFailures, LOGIN_RETRY_MS.length - 1)];
        this.loginFailures++;
        this.retryTimer = setTimeout(() => void this.connectMqtt(), delay);
      }
      this.evaluate();
      return undefined;
    }
    this.signInError = this.lastFailure = undefined;
    this.loginFailures = 0;
    this.evaluate();
    return this.link;
  }

  /** Publishes one latestQuotas and schedules the next: the timer runs whatever the subscriptions did (R§3.5). */
  private requestSnapshot(): void {
    const client = this.client, topics = this.topics;
    if (!client || !topics || !this.connected) return;
    client.publish(topics.get, latestQuotasRequest(this.now()), { qos: 1 }, err => {
      if (err && this.client === client) this.deps.log.warn('ecoflow-app: snapshot request failed', err.name);
    });
    this.armGet();
  }

  private getInterval(): number {
    return this.propertyRefused ? GET_REFUSED_MS : GET_MS;
  }

  private armGet(): void {
    clearTimeout(this.getTimer);
    this.getTimer = setTimeout(() => {
      this.requestSnapshot();
      this.evaluate(); // data that stopped coming goes stale even when no answer arrives
    }, this.getInterval());
  }

  /**
   * Connected yet nothing fresh for twice the request interval (pushes stop after the phone app was used, R§3.3):
   * one reconnect with the same certificate, no login. Once per silence, or a refused property topic with a steady
   * grid would reconnect forever.
   */
  private armStall(): void {
    clearTimeout(this.stallTimer);
    if (!this.connected || this.stallRetried) return;
    this.stallTimer = setTimeout(() => this.stalled(), 2 * this.getInterval());
  }

  private stalled(): void {
    if (!this.client || !this.connected) return;
    this.stallRetried = true;
    this.silentStall = !this.heard;
    this.deps.log.warn(this.heard ? 'ecoflow-app: no fresh data, reconnecting' : 'ecoflow-app: nothing from the station, reconnecting');
    this.endSession();
    void this.connectMqtt();
    this.evaluate();
  }

  private freshData(): void {
    this.stallRetried = false;
    this.armStall();
  }

  private applyPush(q: Record<string, unknown>): void {
    this.heard = true;
    this.quotas.push(q, this.now());
    // A station that pushes is online, whatever an older snapshot said.
    this.online = true;
    this.sessionProven();
    this.freshData();
    this.evaluate();
  }

  /** A snapshot answers our own request, so it proves no session (R12); only a change in it is fresh (R§3.6). */
  private applyReply(r: { online: boolean; quota: Record<string, unknown> | null }): void {
    this.heard = true;
    this.online = r.online;
    if (r.quota && this.quotas.snapshot(r.quota, this.now())) this.freshData();
    this.evaluate();
  }

  private applyProtobuf(): void {
    this.heard = true;
    if (!this.protobuf) {
      this.protobuf = true;
      this.deps.log.info('ecoflow-app: protobuf payload, this model is not supported');
    }
    this.evaluate();
  }

  /** Ends the current client, if any, with its session timers; its later events no longer count. */
  private endSession(): void {
    clearTimeout(this.proofTimer);
    clearTimeout(this.getTimer);
    clearTimeout(this.stallTimer);
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    client?.end(true);
  }

  /** The first error or close of the current client decides what comes next; its later events are ignored. */
  private dropped(client: MqttClientLike, err?: Error & { code?: number }): void {
    if (this.client !== client) return;
    const wasConnected = this.connected;
    this.endSession();
    if (err) this.deps.log.warn('ecoflow-app: mqtt error', err.code ?? err.name);
    if (wasConnected) this.deps.log.warn('ecoflow-app: mqtt closed');
    if (err?.code !== undefined && AUTH_REFUSED.has(err.code)) {
      // Only a new login can renew the certificate: once, then a pause (R§7).
      this.link = undefined;
      if (!this.authRetried) {
        this.authRetried = true;
        this.deps.log.warn('ecoflow-app: mqtt not authorized, signing in again');
        void this.connectMqtt();
      } else {
        this.deps.log.warn('ecoflow-app: mqtt not authorized again, pausing 30 min');
        this.retryTimer = setTimeout(() => void this.connectMqtt(), MQTT_AUTH_PAUSE_MS);
      }
    } else this.backoff();
  }

  /** The session delivered (a live push, or SESSION_PROOF_MS connected): reconnects start over. */
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

  private safe(text: string): string {
    return scrubSecrets(text, [...this.secrets]);
  }

  private evaluate(): void {
    if (this.stopped || !this.onReading) return;
    // A failing consumer must not break the sign-in chain or mqtt.js's message dispatch.
    try { this.onReading(this.reading(this.now())); } catch (err) { this.deps.log.error('ecoflow-app: reading handler failed', err); }
  }

  private reading(now: number): ActualReading {
    if (this.signInError !== undefined) return unknownReading(now, this.safe(errorReason(this.signInError)));
    if (this.silentStall && !this.heard) return unknownReading(now, APP_NO_DATA_REASON);
    // A stray binary frame next to real grid data changes nothing.
    if (this.protobuf && this.quotas.unsupported) return unknownReading(now, APP_UNSUPPORTED_REASON);
    if (this.online === false) return unknownReading(now, OFFLINE_REASON);
    return this.quotas.reading(now);
  }
}
