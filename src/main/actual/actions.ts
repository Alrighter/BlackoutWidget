import { createHash } from 'node:crypto';
import { BLE_LINK_TEXT, BLE_PROBLEM_TEXT, isRiver2Family } from '../../shared/ecoflow-ble';
import type { ActionResult, EcoflowDeviceView, EcoflowPreviewResult, EcoflowTestResult } from '../../shared/ipc';
import type { EcoflowRegion, Settings } from '../../shared/types';
import { describeError, type Logger } from '../log';
import { NetworkError } from '../providers/types';
import { ecoflowAppPreview, ecoflowAppTest, ecoflowPreview, ecoflowTest, type EcoflowPreview } from './ecoflow';
import { deviceLabel, EcoflowApiError, type EcoflowApiLike, type EcoflowDevice, type EcoflowKeys } from './ecoflow/api';
import type { AppAccount, AppSession, EcoflowAppApiLike } from './ecoflow/app-api';
import { transient } from './ecoflow/app-source';
import type { BleLinkLike, ScanOutcome } from './ecoflow/ble/link';
import { authToken } from './ecoflow/ble/token';
import type { MqttConnect } from './ecoflow/source';
import { findActualSource } from './registry';
import { maskEmail, maskKey, scrubKeys, scrubSecrets, SecretsUnavailableError, type SecretStore } from './secrets';
import type { ActualStateService } from './service';
import type { ActualSourceFactory, ActualStateSource } from './types';

const REGIONS: readonly unknown[] = ['eu', 'us'] satisfies EcoflowRegion[];
const BAD_INPUT = 'Перевірте введені дані';
const CONNECT_FAILED = 'Не вдалося зв’язатися з EcoFlow';
const SETTINGS_FAILED = 'Не вдалося зберегти налаштування. Спробуйте ще раз.';
export const KEYS_MISSING_REASON = 'Ключі EcoFlow не знайдено — введіть їх знову в налаштуваннях';
export const ACCOUNT_MISSING_REASON = 'Дані входу EcoFlow не знайдено — увійдіть знову в налаштуваннях';
const CLIENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** How long the previews may reuse the account check's session. */
const SESSION_KEEP_MS = 10 * 60_000;
const HEX = '0123456789ABCDEF';
/** How long the Bluetooth check scans for stations nearby. */
export const SCAN_MS = 8_000;

export interface ActualActionsDeps {
  makeApi(region: EcoflowRegion, keys: EcoflowKeys): EcoflowApiLike;
  makeAppApi(region: EcoflowRegion, account: AppAccount): EcoflowAppApiLike;
  /** MQTT connector for the account preview. */
  connect: MqttConnect;
  /** The Bluetooth check's scan, and the station the running source holds (a connected station does not advertise). */
  ble: Pick<BleLinkLike, 'scan' | 'connectedSn'>;
  secrets: Pick<SecretStore, 'save' | 'remove'>;
  getSettings(): Settings;
  /** Throws when the settings cannot be written: save and disconnect must not report a change that did not happen. */
  updateSettings(patch: Partial<Settings>): void;
  /** Re-reads the settings and keys and restarts ActualStateService. */
  restartActual(): void;
  log: Logger;
  random?: () => number;
  now?: () => number;
}

/** The renderer's EcoFlow calls; every argument is untrusted and checked here. */
export interface ActualActions {
  test(i: unknown): Promise<EcoflowTestResult>;
  preview(i: unknown, sn: unknown): Promise<EcoflowPreviewResult>;
  save(i: unknown, device: unknown): Promise<ActionResult>;
  disconnect(): Promise<void>;
}

/** Made once per installation: the account allows only ~10 different MQTT clientIds a day. */
export function makeClientId(random: () => number = Math.random): string {
  let id = 'BlackoutWidget-';
  for (let i = 0; i < 8; i++) {
    id += CLIENT_ID_CHARS[Math.min(CLIENT_ID_CHARS.length - 1, Math.floor(random() * CLIENT_ID_CHARS.length))];
  }
  return id;
}

/** Made once per installation, like the keys clientId: 32 upper-case hex characters. */
export function makeAppClientUuid(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 32; i++) id += HEX[Math.min(HEX.length - 1, Math.floor(random() * HEX.length))];
  return id;
}

/** The account sign-in that the account and the Bluetooth modes share, and its session cache with it. */
type SignIn = { region: EcoflowRegion; account: AppAccount };
type AccountInput = SignIn & { mode: 'account' };
type BleInput = SignIn & { mode: 'ble' };
type Input = { mode: 'keys'; region: EcoflowRegion; keys: EcoflowKeys } | AccountInput | BleInput;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const badInput = () => ({ ok: false as const, error: BAD_INPUT });

function readKey(v: unknown): string | null {
  const k = typeof v === 'string' ? v.trim() : '';
  return k !== '' && k.length <= 200 ? k : null;
}

/** A password is taken as typed (spaces count); only the email is trimmed. */
function readPassword(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && v.length <= 200 ? v : null;
}

function readInput(i: unknown): Input | null {
  if (!isRecord(i) || !REGIONS.includes(i.region)) return null;
  const region = i.region as EcoflowRegion;
  // No mode means keys: the older renderer calls carry none.
  if (i.mode === undefined || i.mode === 'keys') {
    const accessKey = readKey(i.accessKey), secretKey = readKey(i.secretKey);
    return accessKey && secretKey ? { mode: 'keys', region, keys: { accessKey, secretKey } } : null;
  }
  const mode = i.mode;
  if (mode !== 'account' && mode !== 'ble') return null;
  const email = readKey(i.email), password = readPassword(i.password);
  return email && email.indexOf('@') > 0 && email.indexOf('@') < email.length - 1 && password ? { mode, region, account: { email, password } } : null;
}

/** `more`: secrets met after the input, e.g. the session's userId and token and the Bluetooth token. */
function scrubInput(text: string, input: Input, more: readonly string[] = []): string {
  return input.mode === 'keys'
    ? scrubSecrets(scrubKeys(text, input.keys), more)
    : scrubSecrets(text, [input.account.email, input.account.password, Buffer.from(input.account.password).toString('base64'), ...more]);
}

const deviceView = (d: EcoflowDevice): EcoflowDeviceView => ({ sn: d.sn, label: deviceLabel(d), online: d.online });

/** Letters and digits only: the SN goes into MQTT topics, where `#`, `+` and `/` have a meaning of their own. */
const readSn = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9]{1,64}$/.test(v) ? v : null);

function readDevice(v: unknown): { sn: string; label: string } | null {
  if (!isRecord(v)) return null;
  const sn = readSn(v.sn);
  return sn !== null && typeof v.label === 'string' && v.label.length <= 120 ? { sn, label: v.label } : null;
}

/**
 * The session of the last account check, so the station previews that follow cost no login of their own. One entry,
 * in memory only; the key holds a hash of the password, never the password itself.
 */
function sessionCache(now: () => number) {
  let kept: { key: string; session: AppSession; at: number } | undefined;
  const keyOf = (i: SignIn) => JSON.stringify([i.region, i.account.email, createHash('sha256').update(i.account.password).digest('hex')]);
  return {
    get: (i: SignIn) => (kept && kept.key === keyOf(i) && now() - kept.at < SESSION_KEEP_MS ? kept.session : undefined),
    set: (i: SignIn, session: AppSession) => { kept = { key: keyOf(i), session, at: now() }; },
  };
}

export function createActualActions(deps: ActualActionsDeps): ActualActions {
  const sessions = sessionCache(deps.now ?? (() => Date.now()));
  const fail = (err: unknown, input: Input) => {
    if (err instanceof EcoflowApiError || err instanceof NetworkError) {
      return { ok: false as const, error: scrubInput(err.message, input) };
    }
    deps.log.error(`actual: EcoFlow request failed — ${scrubInput(describeError(err), input)}`);
    return { ok: false as const, error: CONNECT_FAILED };
  };
  /** The other mode's secrets are dead weight once the new ones are saved; a failed removal is only logged. */
  const removeSecrets = (...ids: string[]) => {
    for (const id of ids) {
      try {
        deps.secrets.remove(id);
      } catch (err) {
        deps.log.error(`actual: could not remove the stored ${id} secrets`, err);
      }
    }
  };
  /**
   * Secrets first, then the settings that point at them; the other modes' secrets go only once both are written.
   * `hidden`: secrets beyond the input that an error text must not carry.
   */
  const store = (
    input: Input, id: string, secret: Record<string, string>, patch: () => Partial<Settings>, others: string[], hidden: readonly string[] = [],
  ): ActionResult => {
    try {
      deps.secrets.save(id, secret);
    } catch (err) {
      // Whatever the cause, the secrets are not stored; the cause goes to the log only.
      if (!(err instanceof SecretsUnavailableError)) {
        deps.log.error(`actual: could not save the EcoFlow secrets — ${scrubInput(describeError(err), input, hidden)}`);
      }
      return { ok: false, error: new SecretsUnavailableError(input.mode === 'keys' ? 'keys' : 'account').message };
    }
    try {
      deps.updateSettings(patch());
    } catch (err) {
      // The secrets just stored are not rolled back (ruling R10): a retry overwrites them.
      deps.log.error(`actual: could not save the EcoFlow settings — ${scrubInput(describeError(err), input, hidden)}`);
      return { ok: false, error: SETTINGS_FAILED };
    }
    removeSecrets(...others);
    deps.restartActual();
    return { ok: true };
  };
  /** Never rejects: a scan that fails in any way is the 'scan-failed' problem. Its error text stays out of the log. */
  const scanNearby = async (): Promise<ScanOutcome> => {
    try {
      return await deps.ble.scan(SCAN_MS);
    } catch (err) {
      deps.log.warn(`actual: the Bluetooth scan failed (${err instanceof Error ? err.name : typeof err})`);
      return { adverts: [], problem: 'scan-failed' };
    }
  };
  /** The check's session when it is kept, else a fresh sign-in. Only its userId is used, and that does not go stale. */
  const sessionFor = async (input: SignIn): Promise<AppSession> => {
    const kept = sessions.get(input);
    if (kept) return kept;
    const session = await deps.makeAppApi(input.region, input.account).login();
    sessions.set(input, session);
    return session;
  };
  /** With the check's session when it is kept; a refused certification of it (a token gone bad) earns one fresh login. */
  const previewAccount = async (input: SignIn, station: string): Promise<EcoflowPreview> => {
    const api = deps.makeAppApi(input.region, input.account);
    const run = (session: AppSession) => ecoflowAppPreview(api, deps.connect, station, deps.random, session);
    const signIn = async () => {
      const session = await api.login();
      sessions.set(input, session);
      return session;
    };
    const kept = sessions.get(input);
    if (!kept) return run(await signIn());
    try {
      return await run(kept);
    } catch (err) {
      if (!(err instanceof EcoflowApiError) || transient(err)) throw err;
      return run(await signIn());
    }
  };

  return {
    async test(i) {
      const input = readInput(i);
      if (!input) return badInput();
      // Started before the sign-in so the two run side by side. The scan never fails the check: the stations still come back.
      const scan = input.mode === 'ble' ? scanNearby() : null;
      try {
        if (input.mode === 'keys') return { ok: true, devices: (await ecoflowTest(deps.makeApi(input.region, input.keys))).map(deviceView) };
        const checked = await ecoflowAppTest(deps.makeAppApi(input.region, input.account));
        sessions.set(input, checked.session);
        if (!scan) return { ok: true, devices: checked.devices.map(deviceView) };
        const { adverts, problem } = await scan;
        const seen = new Set(adverts.map(a => a.sn));
        const connected = deps.ble.connectedSn();
        const devices = checked.devices.map(d => ({ ...deviceView(d), nearby: seen.has(d.sn) || d.sn === connected, supported: isRiver2Family(d.sn) }));
        return problem ? { ok: true, devices, bluetooth: BLE_PROBLEM_TEXT[problem] } : { ok: true, devices };
      } catch (err) {
        return fail(err, input);
      }
    },

    async preview(i, sn) {
      const input = readInput(i), station = readSn(sn);
      // The Bluetooth form decides its «Перевірка» text itself and never asks.
      if (!input || station === null || input.mode === 'ble') return badInput();
      try {
        const { online, verdict } = input.mode === 'keys'
          ? await ecoflowPreview(deps.makeApi(input.region, input.keys), station)
          : await previewAccount(input, station);
        return verdict.power === 'unknown'
          ? { ok: true, online, power: 'unknown', reason: verdict.reason, unsupported: verdict.unsupported }
          : { ok: true, online, power: verdict.power, detail: verdict.detail };
      } catch (err) {
        return fail(err, input);
      }
    },

    async save(i, device) {
      const input = readInput(i), station = readDevice(device);
      if (!input || !station) return badInput();
      const { region } = input, { sn: deviceSn, label: deviceName } = station;
      if (input.mode === 'keys') {
        return store(input, 'ecoflow', { ...input.keys }, () => ({
          actualSource: { id: 'ecoflow', region, deviceSn, deviceName, accessKeyHint: maskKey(input.keys.accessKey) },
          ecoflowClientId: deps.getSettings().ecoflowClientId || makeClientId(deps.random),
        }), ['ecoflow-app', 'ecoflow-ble']);
      }
      if (input.mode === 'account') {
        return store(input, 'ecoflow-app', { ...input.account }, () => ({
          actualSource: { id: 'ecoflow-app', region, deviceSn, deviceName, accountHint: maskEmail(input.account.email) },
          ecoflowAppClientUuid: deps.getSettings().ecoflowAppClientUuid || makeAppClientUuid(deps.random),
        }), ['ecoflow', 'ecoflow-ble']);
      }
      if (!isRiver2Family(deviceSn)) return { ok: false, error: BLE_LINK_TEXT.unsupported };
      let session: AppSession;
      try {
        session = await sessionFor(input);
      } catch (err) {
        return fail(err, input);
      }
      // Only the station's token is kept; the password and the userId go no further than this call.
      const token = authToken(session.userId, deviceSn);
      return store(input, 'ecoflow-ble', { token }, () => ({
        actualSource: { id: 'ecoflow-ble', region, deviceSn, deviceName, accountHint: maskEmail(input.account.email) },
      }), ['ecoflow', 'ecoflow-app'], [session.userId, session.token, token]);
    },

    async disconnect() {
      try {
        deps.updateSettings({ actualSource: null });
      } catch (err) {
        // The settings still point at the source, so its secrets must stay too.
        deps.log.error('actual: could not save the settings on disconnect', err);
        throw err;
      }
      removeSecrets('ecoflow', 'ecoflow-app', 'ecoflow-ble');
      deps.restartActual();
    },
  };
}

export interface ActualRestartDeps {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  secrets: Pick<SecretStore, 'load'>;
  service: Pick<ActualStateService, 'start' | 'stop'>;
  sources: ActualSourceFactory[];
  log: Logger;
  random?: () => number;
  now?: () => number;
}

/** Stands in while the saved keys or account cannot be read (another Windows user, a damaged file): unknown, with the reason. */
function secretsMissingSource(now: () => number, reason: string): ActualStateSource {
  return {
    start: onReading => onReading({ power: 'unknown', observedAt: new Date(now()).toISOString(), reason }),
    stop() {},
  };
}

/**
 * Re-reads the settings and keys and starts the configured source, or stops the service when there is none.
 * Never throws: false (logged) when the source could not be started, e.g. a locked history file.
 */
export function createActualRestart(deps: ActualRestartDeps): () => boolean {
  const now = deps.now ?? Date.now;
  return () => {
    try {
      const settings = deps.getSettings();
      const config = settings.actualSource;
      if (!config) {
        deps.service.stop();
        return true;
      }
      const factory = findActualSource(deps.sources, config.id);
      const label = `${factory.displayName} · ${config.deviceName}`;
      const app = config.id === 'ecoflow-app';
      const ble = config.id === 'ecoflow-ble';
      // The Bluetooth source has no MQTT clientId.
      let clientId = ble ? '' : app ? settings.ecoflowAppClientUuid : settings.ecoflowClientId;
      if (!clientId && !ble) {
        clientId = app ? makeAppClientUuid(deps.random) : makeClientId(deps.random);
        deps.updateSettings(app ? { ecoflowAppClientUuid: clientId } : { ecoflowClientId: clientId });
      }
      const secrets = deps.secrets.load(config.id);
      const complete = ble
        ? typeof secrets?.token === 'string' && /^[0-9A-F]{32}$/.test(secrets.token)
        : app
          ? typeof secrets?.email === 'string' && typeof secrets.password === 'string'
          : typeof secrets?.accessKey === 'string' && typeof secrets.secretKey === 'string';
      if (!secrets || !complete) {
        deps.service.start(secretsMissingSource(now, app || ble ? ACCOUNT_MISSING_REASON : KEYS_MISSING_REASON), label);
        return true;
      }
      deps.service.start(factory.create(config, secrets, { clientId: clientId ?? '', log: deps.log }), label);
      return true;
    } catch (err) {
      deps.log.error('actual: could not start the source', err);
      return false;
    }
  };
}
