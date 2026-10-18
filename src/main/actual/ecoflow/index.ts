import type { ActualSourceFactory } from '../types';
import { EcoflowApi, type EcoflowApiLike, type EcoflowDevice, type FetchLike } from './api';
import { EcoflowAppApi, type AppSession, type EcoflowAppApiLike } from './app-api';
import { APP_AUTH_REFUSED_REASON, APP_UNSUPPORTED_REASON, appClientId, appTopics, EcoflowAppSource } from './app-source';
import { detectGrid, type GridVerdict } from './grid';
import { latestQuotasRequest, parseGetReply, parseJsonObject } from './mqtt-message';
import { AUTH_REFUSED, connectBroker } from './mqtt-session';
import { OFFLINE_REASON } from './quota-tracker';
import { EcoflowSource, type MqttConnect } from './source';

export interface EcoflowPreview { online: boolean; verdict: GridVerdict }

export function createEcoflowFactory(deps: { fetch: FetchLike; connect: MqttConnect }): ActualSourceFactory {
  return {
    id: 'ecoflow',
    displayName: 'EcoFlow',
    create: (config, secrets, ctx) => {
      const keys = { accessKey: secrets.accessKey, secretKey: secrets.secretKey };
      return new EcoflowSource(
        { sn: config.deviceSn, clientId: ctx.clientId, keys },
        new EcoflowApi(config.region, keys, { fetch: deps.fetch }),
        { connect: deps.connect, log: ctx.log },
      );
    },
  };
}

export function ecoflowTest(api: EcoflowApiLike): Promise<EcoflowDevice[]> {
  return api.listDevices();
}

/** HTTP only: an MQTT connection here would spend one of the account's few daily clientIds on a preview. */
export async function ecoflowPreview(api: EcoflowApiLike, sn: string): Promise<EcoflowPreview> {
  const [devices, quota] = await Promise.all([api.listDevices(), api.getQuotaAll(sn)]);
  return { online: devices.find(d => d.sn === sn)?.online ?? false, verdict: detectGrid(quota) };
}

export const PREVIEW_WAIT_MS = 10_000;
export const AFTER_SAVE_REASON = 'стан світла з’явиться після збереження';
const HEX = '0123456789ABCDEF';

/** `secrets` are `{ email, password }`; `ctx.clientId` is the persisted 32-hex uuid, the middle of the MQTT clientId. */
export function createEcoflowAppFactory(deps: { fetch: FetchLike; connect: MqttConnect }): ActualSourceFactory {
  return {
    id: 'ecoflow-app',
    displayName: 'EcoFlow',
    create: (config, secrets, ctx) => {
      const account = { email: secrets.email, password: secrets.password };
      return new EcoflowAppSource(
        { sn: config.deviceSn, clientUuid: ctx.clientId, account },
        new EcoflowAppApi(config.region, account, { fetch: deps.fetch }),
        { connect: deps.connect, log: ctx.log },
      );
    },
  };
}

/** The session comes back too: the previews that follow reuse it instead of logging in again. */
export async function ecoflowAppTest(api: EcoflowAppApiLike): Promise<{ session: AppSession; devices: EcoflowDevice[] }> {
  const session = await api.login();
  return { session, devices: await api.listDevices(session) };
}

/**
 * One short MQTT session: one latestQuotas, at most PREVIEW_WAIT_MS for the reply. The clientId is a throw-away one:
 * the running source may hold the persisted id, and two clients with one id kick each other off (R§3.2).
 * `online` is false only when the reply says so; without a reply the form shows the reason instead.
 * `given`: a session already made (the account check's); without one the preview logs in itself.
 */
export async function ecoflowAppPreview(
  api: EcoflowAppApiLike, connect: MqttConnect, sn: string, random: () => number = Math.random, given?: AppSession,
): Promise<EcoflowPreview> {
  const session = given ?? await api.login();
  const cert = await api.getCertification(session);
  const topics = appTopics(session.userId, sn);
  let uuid = '';
  for (let i = 0; i < 32; i++) uuid += HEX[Math.min(HEX.length - 1, Math.floor(random() * HEX.length))];
  const client = connectBroker(connect, cert, appClientId(uuid, session.userId));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<EcoflowPreview>(resolve => {
      const noReply = () => resolve({ online: true, verdict: { power: 'unknown', reason: AFTER_SAVE_REASON, unsupported: false } });
      // A refused CONNACK is an answer, not a missing reply: «після збереження» would promise data that may not come.
      const refused = () => resolve({ online: true, verdict: { power: 'unknown', reason: APP_AUTH_REFUSED_REASON, unsupported: false } });
      timer = setTimeout(noReply, PREVIEW_WAIT_MS);
      client.on('connect', () => {
        client.subscribe([topics.reply], { qos: 1 });
        client.publish(topics.get, latestQuotasRequest(Date.now()), { qos: 1 });
      });
      client.on('message', (topic, payload, packet) => {
        if (topic !== topics.reply || packet?.retain) return;
        const msg = parseJsonObject(payload);
        if (!msg) {
          resolve({ online: true, verdict: { power: 'unknown', reason: APP_UNSUPPORTED_REASON, unsupported: true } });
          return;
        }
        const r = parseGetReply(msg);
        if (!r) return;
        resolve(r.online
          ? { online: true, verdict: detectGrid(r.quota ?? {}) }
          : { online: false, verdict: { power: 'unknown', reason: OFFLINE_REASON, unsupported: false } });
      });
      client.on('error', err => (err.code !== undefined && AUTH_REFUSED.has(err.code) ? refused() : noReply()));
      client.on('close', noReply);
    });
  } finally {
    clearTimeout(timer);
    client.end(true);
  }
}
