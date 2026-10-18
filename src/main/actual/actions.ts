import type { ActionResult, EcoflowPreviewResult, EcoflowTestResult } from '../../shared/ipc';
import type { EcoflowRegion, Settings } from '../../shared/types';
import { describeError, type Logger } from '../log';
import { NetworkError } from '../providers/types';
import { ecoflowAppPreview, ecoflowAppTest, ecoflowPreview, ecoflowTest } from './ecoflow';
import { deviceLabel, EcoflowApiError, type EcoflowApiLike, type EcoflowKeys } from './ecoflow/api';
import type { AppAccount, EcoflowAppApiLike } from './ecoflow/app-api';
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
const HEX = '0123456789ABCDEF';

export interface ActualActionsDeps {
  makeApi(region: EcoflowRegion, keys: EcoflowKeys): EcoflowApiLike;
  makeAppApi(region: EcoflowRegion, account: AppAccount): EcoflowAppApiLike;
  /** MQTT connector for the account preview. */
  connect: MqttConnect;
  secrets: Pick<SecretStore, 'save' | 'remove'>;
  getSettings(): Settings;
  /** Throws when the settings cannot be written: save and disconnect must not report a change that did not happen. */
  updateSettings(patch: Partial<Settings>): void;
  /** Re-reads the settings and keys and restarts ActualStateService. */
  restartActual(): void;
  log: Logger;
  random?: () => number;
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

type Input =
  | { mode: 'keys'; region: EcoflowRegion; keys: EcoflowKeys }
  | { mode: 'account'; region: EcoflowRegion; account: AppAccount };

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
  if (i.mode !== 'account') return null;
  const email = readKey(i.email), password = readPassword(i.password);
  return email && email.indexOf('@') > 0 && email.indexOf('@') < email.length - 1 && password ? { mode: 'account', region, account: { email, password } } : null;
}

function scrubInput(text: string, input: Input): string {
  return input.mode === 'keys'
    ? scrubKeys(text, input.keys)
    : scrubSecrets(text, [input.account.email, input.account.password, Buffer.from(input.account.password).toString('base64')]);
}

const readSn = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 64 ? v : null);

function readDevice(v: unknown): { sn: string; label: string } | null {
  if (!isRecord(v)) return null;
  const sn = readSn(v.sn);
  return sn !== null && typeof v.label === 'string' && v.label.length <= 120 ? { sn, label: v.label } : null;
}

export function createActualActions(deps: ActualActionsDeps): ActualActions {
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

  return {
    async test(i) {
      const input = readInput(i);
      if (!input) return badInput();
      try {
        const devices = input.mode === 'keys'
          ? await ecoflowTest(deps.makeApi(input.region, input.keys))
          : await ecoflowAppTest(deps.makeAppApi(input.region, input.account));
        return { ok: true, devices: devices.map(d => ({ sn: d.sn, label: deviceLabel(d), online: d.online })) };
      } catch (err) {
        return fail(err, input);
      }
    },

    async preview(i, sn) {
      const input = readInput(i), station = readSn(sn);
      if (!input || station === null) return badInput();
      try {
        const { online, verdict } = input.mode === 'keys'
          ? await ecoflowPreview(deps.makeApi(input.region, input.keys), station)
          : await ecoflowAppPreview(deps.makeAppApi(input.region, input.account), deps.connect, station, deps.random);
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
      try {
        if (input.mode === 'keys') deps.secrets.save('ecoflow', { ...input.keys });
        else deps.secrets.save('ecoflow-app', { ...input.account });
      } catch (err) {
        // Whatever the cause, the secrets are not stored; the cause goes to the log only.
        if (!(err instanceof SecretsUnavailableError)) {
          deps.log.error(`actual: could not save the EcoFlow secrets — ${scrubInput(describeError(err), input)}`);
        }
        return { ok: false, error: new SecretsUnavailableError().message };
      }
      try {
        const current = deps.getSettings();
        deps.updateSettings(input.mode === 'keys'
          ? {
            actualSource: {
              id: 'ecoflow', region: input.region, deviceSn: station.sn, deviceName: station.label, accessKeyHint: maskKey(input.keys.accessKey),
            },
            ecoflowClientId: current.ecoflowClientId || makeClientId(deps.random),
          }
          : {
            actualSource: {
              id: 'ecoflow-app', region: input.region, deviceSn: station.sn, deviceName: station.label, accountHint: maskEmail(input.account.email),
            },
            ecoflowAppClientUuid: current.ecoflowAppClientUuid || makeAppClientUuid(deps.random),
          });
      } catch (err) {
        // The secrets just stored are not rolled back (ruling R10): a retry overwrites them.
        deps.log.error(`actual: could not save the EcoFlow settings — ${scrubInput(describeError(err), input)}`);
        return { ok: false, error: SETTINGS_FAILED };
      }
      removeSecrets(input.mode === 'keys' ? 'ecoflow-app' : 'ecoflow');
      deps.restartActual();
      return { ok: true };
    },

    async disconnect() {
      try {
        deps.updateSettings({ actualSource: null });
      } catch (err) {
        // The settings still point at the source, so its secrets must stay too.
        deps.log.error('actual: could not save the settings on disconnect', err);
        throw err;
      }
      removeSecrets('ecoflow', 'ecoflow-app');
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
      let clientId = app ? settings.ecoflowAppClientUuid : settings.ecoflowClientId;
      if (!clientId) {
        clientId = app ? makeAppClientUuid(deps.random) : makeClientId(deps.random);
        deps.updateSettings(app ? { ecoflowAppClientUuid: clientId } : { ecoflowClientId: clientId });
      }
      const secrets = deps.secrets.load(config.id);
      const complete = app
        ? typeof secrets?.email === 'string' && typeof secrets.password === 'string'
        : typeof secrets?.accessKey === 'string' && typeof secrets.secretKey === 'string';
      if (!secrets || !complete) {
        deps.service.start(secretsMissingSource(now, app ? ACCOUNT_MISSING_REASON : KEYS_MISSING_REASON), label);
        return true;
      }
      deps.service.start(factory.create(config, secrets, { clientId, log: deps.log }), label);
      return true;
    } catch (err) {
      deps.log.error('actual: could not start the source', err);
      return false;
    }
  };
}
