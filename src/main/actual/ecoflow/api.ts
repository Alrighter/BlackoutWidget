import type { EcoflowRegion } from '../../../shared/types';
import { NetworkError } from '../../providers/types';
import { hmacHex, signString } from './sign';

export const ECOFLOW_HOSTS: Record<EcoflowRegion, string> = {
  eu: 'https://api-e.ecoflow.com',
  us: 'https://api.ecoflow.com',
};

export interface EcoflowKeys { accessKey: string; secretKey: string }
export interface EcoflowDevice { sn: string; online: boolean; productName?: string; deviceName?: string }
export interface MqttCertificate { account: string; password: string; host: string; port: number }
export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const KEY_CODES = new Set(['8521', '8524', '8513']);
const KEY_MESSAGE = /accessKey is invalid|doesn.?t exist|does not exist/i;

export function describeEcoflowError(code: string, apiMessage: string): string {
  switch (code) {
    case '1006': return 'EcoFlow не віддає дані цієї станції через API розробника (1006). Можливо, станція прив’язана до іншого акаунта або ця модель не підтримується.';
    case '8521': return 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.';
    case '8524': return 'EcoFlow не прийняв час запиту (8524). Перевірте, чи правильно виставлено час на комп’ютері.';
    case '8513': return 'Схоже, ключі з іншого регіону (8513). Спробуйте інший регіон.';
    case 'timeout': return 'EcoFlow не відповідає. Спробуйте пізніше.';
    case 'bad-json': return 'EcoFlow повернув незрозумілу відповідь.';
  }
  if (KEY_MESSAGE.test(apiMessage)) return 'EcoFlow не знає такого Access Key. Перевірте ключ і регіон.';
  const http = /^http-(\d+)$/.exec(code);
  if (http) return `EcoFlow не відповідає (HTTP ${http[1]}).`;
  return `Помилка EcoFlow ${code}: ${apiMessage}`;
}

export class EcoflowApiError extends Error {
  readonly code: string;
  /** The keys (or region) are wrong: polling should back off instead of retrying every minute. */
  readonly keyProblem: boolean;
  constructor(code: string, apiMessage = '') {
    super(describeEcoflowError(code, apiMessage));
    this.name = 'EcoflowApiError';
    this.code = code;
    this.keyProblem = KEY_CODES.has(code) || KEY_MESSAGE.test(apiMessage);
  }
}

export function deviceLabel(d: EcoflowDevice): string {
  return d.productName ?? d.deviceName ?? d.sn;
}

export interface EcoflowApiLike {
  listDevices(): Promise<EcoflowDevice[]>;
  getQuotaAll(sn: string): Promise<Record<string, unknown>>;
  getCertification(): Promise<MqttCertificate>;
}

export class EcoflowApi implements EcoflowApiLike {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly region: EcoflowRegion,
    private readonly keys: EcoflowKeys,
    private readonly deps: { fetch: FetchLike; now?: () => number; random?: () => number; timeoutMs?: number },
  ) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.timeoutMs = deps.timeoutMs ?? 15000;
  }

  async listDevices(): Promise<EcoflowDevice[]> {
    const data = await this.get('/iot-open/sign/device/list');
    if (!Array.isArray(data)) throw new EcoflowApiError('bad-json');
    return data.map((d: any) => ({
      sn: String(d.sn),
      online: d.online === 1 || d.online === true,
      ...(d.productName ? { productName: String(d.productName) } : {}),
      ...(d.deviceName ? { deviceName: String(d.deviceName) } : {}),
    }));
  }

  async getQuotaAll(sn: string): Promise<Record<string, unknown>> {
    const data = await this.get('/iot-open/sign/device/quota/all', { sn });
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new EcoflowApiError('bad-json');
    return data as Record<string, unknown>;
  }

  async getCertification(): Promise<MqttCertificate> {
    const d: any = await this.get('/iot-open/sign/certification');
    const port = Number(d?.port);
    if (!d || !d.certificateAccount || !d.certificatePassword || !d.url || !Number.isFinite(port)) throw new EcoflowApiError('bad-json');
    return { account: String(d.certificateAccount), password: String(d.certificatePassword), host: String(d.url), port };
  }

  private async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const nonce = String(Math.min(999999, Math.round(this.random() * 1e6))).padStart(6, '0');
    const timestamp = String(this.now());
    const sign = hmacHex(signString(params, this.keys.accessKey, nonce, timestamp), this.keys.secretKey);
    const query = params ? `?${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      let text: string;
      try {
        res = await this.deps.fetch(`${ECOFLOW_HOSTS[this.region]}${path}${query}`, {
          method: 'GET',
          headers: { accessKey: this.keys.accessKey, nonce, timestamp, sign },
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch {
        throw timedOut ? new EcoflowApiError('timeout') : new NetworkError('Немає з’єднання з EcoFlow');
      }
      if (!res.ok) throw new EcoflowApiError(`http-${res.status}`);
      let body: any;
      try { body = JSON.parse(text); } catch { throw new EcoflowApiError('bad-json'); }
      if (body === null || typeof body !== 'object') throw new EcoflowApiError('bad-json');
      if (String(body.code) !== '0') throw new EcoflowApiError(String(body.code), String(body.message ?? ''));
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
