import type { ActualSourceFactory } from '../types';
import { EcoflowApi, type EcoflowApiLike, type EcoflowDevice, type FetchLike } from './api';
import { detectGrid, type GridVerdict } from './grid';
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
