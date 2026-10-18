import type { EcoflowRegion } from '../../../shared/types';
import { NetworkError } from '../../providers/types';
import { ECOFLOW_HOSTS, EcoflowApiError, type EcoflowDevice, type FetchLike, type MqttCertificate } from './api';

export interface AppAccount { email: string; password: string }
export interface AppSession { token: string; userId: string }

export interface EcoflowAppApiLike {
  login(): Promise<AppSession>;
  getCertification(s: AppSession): Promise<MqttCertificate>;
  listDevices(s: AppSession): Promise<EcoflowDevice[]>;
}

// Headers the phone app sends; some EcoFlow endpoints answer differently without them (R§1.2).
const APP_HEADERS = { lang: 'en_US', platform: 'android', version: '4.1.2.02', 'user-agent': 'okhttp/3.14.9' };

export class EcoflowAppApi implements EcoflowAppApiLike {
  private readonly timeoutMs: number;

  constructor(
    private readonly region: EcoflowRegion,
    private readonly account: AppAccount,
    private readonly deps: { fetch: FetchLike; timeoutMs?: number },
  ) {
    this.timeoutMs = deps.timeoutMs ?? 15000;
  }

  async login(): Promise<AppSession> {
    const body = JSON.stringify({
      email: this.account.email,
      password: Buffer.from(this.account.password, 'utf8').toString('base64'),
      scene: 'IOT_APP',
      userType: 'ECOFLOW',
    });
    const d: any = await this.request('/auth/login', { method: 'POST', headers: { ...APP_HEADERS, 'content-type': 'application/json' }, body });
    // A JSON number would already have lost precision past 2^53; the wire value is a string (R§1.4), String() just normalises.
    const userId = d?.user?.userId;
    if (!d || typeof d.token !== 'string' || !d.token || userId === undefined || userId === null || userId === '') throw new EcoflowApiError('bad-json');
    return { token: d.token, userId: String(userId) };
  }

  async getCertification(s: AppSession): Promise<MqttCertificate> {
    const d: any = await this.authed(`/iot-auth/app/certification?userId=${encodeURIComponent(s.userId)}`, s);
    const port = Number(d?.port);
    if (!d || !d.certificateAccount || !d.certificatePassword || !d.url || !Number.isFinite(port)) throw new EcoflowApiError('bad-json');
    return { account: String(d.certificateAccount), password: String(d.certificatePassword), host: String(d.url), port };
  }

  async listDevices(s: AppSession): Promise<EcoflowDevice[]> {
    const d: any = await this.authed(`/iot-service/user/device?userId=${encodeURIComponent(s.userId)}`, s);
    if (d === undefined || d === null) return [];
    if (typeof d !== 'object') throw new EcoflowApiError('bad-json');
    return [...flattenGroup(d.bound), ...flattenGroup(d.share)];
  }

  private authed(path: string, s: AppSession): Promise<unknown> {
    return this.request(path, { method: 'GET', headers: { ...APP_HEADERS, authorization: `Bearer ${s.token}` } });
  }

  private async request(path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<unknown> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      let text: string;
      try {
        res = await this.deps.fetch(`${ECOFLOW_HOSTS[this.region]}${path}`, { ...init, signal: ctrl.signal });
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

/** `bound`/`share` come keyed by SN, as a list, or as groups of lists (R§4); all flatten to devices. */
function flattenGroup(group: unknown, sn?: string): EcoflowDevice[] {
  if (Array.isArray(group)) return group.flatMap(item => flattenGroup(item, sn));
  if (group === null || typeof group !== 'object') return [];
  const g = group as Record<string, any>;
  const id = g.sn ?? sn;
  if (id !== undefined && id !== null && id !== '' && ('online' in g || 'deviceName' in g || 'productName' in g || 'sn' in g)) {
    return [{
      sn: String(id),
      online: g.online === 1 || g.online === true,
      ...(g.productName ? { productName: String(g.productName) } : {}),
      ...(g.deviceName ? { deviceName: String(g.deviceName) } : {}),
    }];
  }
  return Object.entries(g).flatMap(([key, v]) => flattenGroup(v, key));
}
