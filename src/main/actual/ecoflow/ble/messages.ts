import type { Fields } from './heartbeats';

/**
 * The BLE host's protocol with main, over the utilityProcess port. Every text here is English and log-safe: at most the
 * SN's 4-character prefix, never the token.
 */

export type AdapterState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' | 'resetting';

export type LinkState = 'idle' | 'searching' | 'connecting' | 'connected' | 'refused' | 'stalled' | 'unsupported' | 'lost';

export interface AdvertView { sn: string; soc: number; rssi: number; encryptType: number }

export type HostCommand =
  | { cmd: 'watch'; sn: string; token: string } | { cmd: 'unwatch' }
  | { cmd: 'scan'; id: number; ms: number } | { cmd: 'suspend' } | { cmd: 'resume' }
  | { cmd: 'probe'; id: number };                 // smoke only: first EcoFlow advert, handshake to auth status, no auth

export type HostEvent =
  | { ev: 'adapter'; state: AdapterState }
  | { ev: 'link'; sn: string; state: LinkState; detail?: string }   // detail: English, log-safe ('auth code 6', 'no reply in auth-status')
  | { ev: 'heartbeat'; sn: string; module: 'inv' | 'pd' | 'mppt'; fields: Fields }
  | { ev: 'scan-result'; id: number; adverts: AdvertView[] }
  | { ev: 'probe-result'; id: number; ok: boolean; detail: string }
  | { ev: 'log'; level: 'info' | 'warn' | 'error'; text: string };
