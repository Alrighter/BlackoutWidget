import type { ActionResult, EcoflowPreviewResult, EcoflowTestResult } from '../../shared/ipc';
import type { EcoflowRegion, Settings } from '../../shared/types';
import { describeError, type Logger } from '../log';
import { NetworkError } from '../providers/types';
import { ecoflowPreview, ecoflowTest } from './ecoflow';
import { deviceLabel, EcoflowApiError, type EcoflowApiLike, type EcoflowKeys } from './ecoflow/api';
import { findActualSource } from './registry';
import { maskKey, scrubKeys, SecretsUnavailableError, type SecretStore } from './secrets';
import type { ActualStateService } from './service';
import type { ActualSourceFactory, ActualStateSource } from './types';

const REGIONS: readonly unknown[] = ['eu', 'us'] satisfies EcoflowRegion[];
const BAD_INPUT = 'Перевірте введені дані';
const CONNECT_FAILED = 'Не вдалося зв’язатися з EcoFlow';
const SETTINGS_FAILED = 'Не вдалося зберегти налаштування. Спробуйте ще раз.';
export const KEYS_MISSING_REASON = 'Ключі EcoFlow не знайдено — введіть їх знову в налаштуваннях';
const CLIENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface ActualActionsDeps {
  makeApi(region: EcoflowRegion, keys: EcoflowKeys): EcoflowApiLike;
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

interface KeysInput { region: EcoflowRegion; keys: EcoflowKeys }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const badInput = () => ({ ok: false as const, error: BAD_INPUT });

function readKey(v: unknown): string | null {
  const k = typeof v === 'string' ? v.trim() : '';
  return k !== '' && k.length <= 200 ? k : null;
}

function readKeys(i: unknown): KeysInput | null {
  if (!isRecord(i) || !REGIONS.includes(i.region)) return null;
  const accessKey = readKey(i.accessKey), secretKey = readKey(i.secretKey);
  return accessKey && secretKey ? { region: i.region as EcoflowRegion, keys: { accessKey, secretKey } } : null;
}

const readSn = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 64 ? v : null);

function readDevice(v: unknown): { sn: string; label: string } | null {
  if (!isRecord(v)) return null;
  const sn = readSn(v.sn);
  return sn !== null && typeof v.label === 'string' && v.label.length <= 120 ? { sn, label: v.label } : null;
}

export function createActualActions(deps: ActualActionsDeps): ActualActions {
  const fail = (err: unknown, keys: EcoflowKeys) => {
    if (err instanceof EcoflowApiError || err instanceof NetworkError) {
      return { ok: false as const, error: scrubKeys(err.message, keys) };
    }
    deps.log.error(`actual: EcoFlow request failed — ${scrubKeys(describeError(err), keys)}`);
    return { ok: false as const, error: CONNECT_FAILED };
  };

  return {
    async test(i) {
      const input = readKeys(i);
      if (!input) return badInput();
      try {
        const devices = await ecoflowTest(deps.makeApi(input.region, input.keys));
        return { ok: true, devices: devices.map(d => ({ sn: d.sn, label: deviceLabel(d), online: d.online })) };
      } catch (err) {
        return fail(err, input.keys);
      }
    },

    async preview(i, sn) {
      const input = readKeys(i), station = readSn(sn);
      if (!input || station === null) return badInput();
      try {
        const { online, verdict } = await ecoflowPreview(deps.makeApi(input.region, input.keys), station);
        return verdict.power === 'unknown'
          ? { ok: true, online, power: 'unknown', reason: verdict.reason, unsupported: verdict.unsupported }
          : { ok: true, online, power: verdict.power, detail: verdict.detail };
      } catch (err) {
        return fail(err, input.keys);
      }
    },

    async save(i, device) {
      const input = readKeys(i), station = readDevice(device);
      if (!input || !station) return badInput();
      try {
        deps.secrets.save('ecoflow', { ...input.keys });
      } catch (err) {
        // Whatever the cause, the keys are not stored; the cause goes to the log only.
        if (!(err instanceof SecretsUnavailableError)) {
          deps.log.error(`actual: could not save the EcoFlow keys — ${scrubKeys(describeError(err), input.keys)}`);
        }
        return { ok: false, error: new SecretsUnavailableError().message };
      }
      try {
        deps.updateSettings({
          actualSource: {
            id: 'ecoflow', region: input.region, deviceSn: station.sn, deviceName: station.label, accessKeyHint: maskKey(input.keys.accessKey),
          },
          ecoflowClientId: deps.getSettings().ecoflowClientId || makeClientId(deps.random),
        });
      } catch (err) {
        // The keys just stored are not rolled back (ruling R10): a retry overwrites them.
        deps.log.error(`actual: could not save the EcoFlow settings — ${scrubKeys(describeError(err), input.keys)}`);
        return { ok: false, error: SETTINGS_FAILED };
      }
      deps.restartActual();
      return { ok: true };
    },

    async disconnect() {
      try {
        deps.updateSettings({ actualSource: null });
      } catch (err) {
        // The settings still point at the source, so its keys must stay too.
        deps.log.error('actual: could not save the settings on disconnect', err);
        throw err;
      }
      try {
        deps.secrets.remove('ecoflow');
      } catch (err) {
        deps.log.error('actual: could not remove the EcoFlow keys', err);
      }
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

/** Stands in while the saved keys cannot be read (another Windows user, a damaged file): unknown, with the reason. */
function keysMissingSource(now: () => number): ActualStateSource {
  return {
    start: onReading => onReading({ power: 'unknown', observedAt: new Date(now()).toISOString(), reason: KEYS_MISSING_REASON }),
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
      let clientId = settings.ecoflowClientId;
      if (!clientId) {
        clientId = makeClientId(deps.random);
        deps.updateSettings({ ecoflowClientId: clientId });
      }
      const secrets = deps.secrets.load(config.id);
      if (typeof secrets?.accessKey !== 'string' || typeof secrets.secretKey !== 'string') {
        deps.service.start(keysMissingSource(now), label);
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
