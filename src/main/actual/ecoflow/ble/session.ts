import { heartbeatOf } from './heartbeats';
import { authToken, newEphemeralKey, sessionKey, sharedSecret, SessionCipher } from './crypto';
import { decodePacket, encodeFrame, encodePacket, FRAME_COMMAND, FRAME_PROTOCOL, FrameReader, type Frame, type Packet } from './protocol';

type Incoming = Frame | Packet;
const isPacket = (f: Incoming): f is Packet => 'src' in f;
const isCommand = (f: Incoming, kind: number, min: number): f is Frame =>
  !isPacket(f) && f.type === FRAME_COMMAND && f.payload[0] === kind && f.payload.length >= min;

/**
 * One read-only BLE session with an encrypt-type-7 EcoFlow station (RIVER 2 family), ported from rabits/ha-ef-ble at
 * 1c1eb33 connection.py (Apache License 2.0). The transport is the caller's: it writes with response to characteristic
 * …0002 and feeds every notification from …0003 to `handle`.
 *
 * Read-only by construction: `send` refuses everything but the two handshake commands and the two auth requests, so
 * nothing here can bind the station (0x35/0x85), set its clock (a 0x35/0x01/0x52 reply) or switch an output (0x20/…).
 */

export type SessionStage = 'public-key' | 'session-key' | 'auth-status' | 'auth' | 'streaming' | 'failed';

/** The auth reply's error codes (ha-ef-ble exceptions.py `AuthErrors`). */
export const AUTH_ERRORS: Record<number, string> = {
  1: 'NeedRefreshToken', 2: 'DeviceInternalError', 3: 'DeviceAlreadyBound', 4: 'NeedBindInstallFirst',
  5: 'AppSendDataError', 6: 'WrongKey', 7: 'MaximumDevicesError',
};

export class SessionError extends Error {
  constructor(readonly stage: SessionStage, message: string) { super(message); }
}

export interface SessionOptions {
  userId: string;
  sn: string;
  write(data: Buffer): Promise<void>;
  /** Every decoded packet once the session key is in place, the auth replies included. */
  onPacket?(p: Packet): void;
  onStage?(stage: SessionStage): void;
  /** A protocol frame that did not decode: after a few in a row the key no longer matches. */
  onBadFrame?(error: Error): void;
  stageTimeoutMs?: number;
  /** Stop once the station answers the auth-status request: proves the key exchange without the account. */
  stopAfterAuthStatus?: boolean;
}

const SRC_APP = 0x21;
const DST_AUTH = 0x35;
const AUTH_STATUS = { src: SRC_APP, dst: DST_AUTH, cmdSet: 0x35, cmdId: 0x89 } as const;
const AUTH = { src: SRC_APP, dst: DST_AUTH, cmdSet: 0x35, cmdId: 0x86 } as const;

export class EcoflowBleSession {
  private readonly reader = new FrameReader();
  private stage: SessionStage = 'public-key';
  private cipher: SessionCipher | null = null;
  private waiter: { accept(item: Incoming): boolean } | null = null;

  constructor(private readonly o: SessionOptions) {}

  get currentStage(): SessionStage { return this.stage; }

  /** Runs the handshake and auth; resolves once the station accepts us (then packets keep coming via onPacket). */
  async start(): Promise<void> {
    try {
      const key = newEphemeralKey();
      const pub = await this.exchange('public-key', encodeFrame(FRAME_COMMAND, Buffer.concat([Buffer.from([0x01, 0x00]), key.publicKey])),
        (f): f is Frame => isCommand(f, 0x01, 43));
      const curve = pub.payload[2];
      if (curve >= 1 && curve <= 4) throw new SessionError('public-key', `unsupported ECDH curve ${curve}`);
      const initial = SessionCipher.fromShared(sharedSecret(key.secretKey, pub.payload.subarray(3, 43)));

      const info = await this.exchange('session-key', encodeFrame(FRAME_COMMAND, Buffer.from([0x02])),
        (f): f is Frame => isCommand(f, 0x02, 33));
      const material = initial.decrypt(info.payload.subarray(1));
      this.cipher = new SessionCipher(sessionKey(material.subarray(16, 18), material.subarray(0, 16)), initial.iv);

      await this.exchange('auth-status', this.packetFrame(AUTH_STATUS), (f): f is Packet => isPacket(f) && f.src === DST_AUTH && f.cmdSet === 0x35);
      if (this.o.stopAfterAuthStatus) return;

      const reply = await this.exchange('auth', this.packetFrame({ ...AUTH, payload: authToken(this.o.userId, this.o.sn) }),
        // The auth reply, or (as ha-ef-ble accepts) a first heartbeat. Anything else from the station, such as its clock
        // request, proves nothing: a refusal can still follow it.
        (f): f is Packet => isPacket(f) && ((f.src === DST_AUTH && f.cmdSet === 0x35 && f.cmdId === 0x86) || heartbeatOf(f) !== null));
      if (reply.src === DST_AUTH && reply.cmdId === 0x86 && reply.payload.length && reply.payload[0] !== 0) {
        const code = reply.payload[0];
        throw new SessionError('auth', `station refused auth: ${code} ${AUTH_ERRORS[code] ?? 'unknown'}`);
      }
      this.setStage('streaming');
    } catch (e) {
      const stage = this.stage;
      this.setStage('failed');
      throw e instanceof SessionError ? e : new SessionError(stage, String((e as Error)?.message ?? e));
    }
  }

  /** Feed one notification from the station. */
  handle(chunk: Uint8Array): void {
    for (const frame of this.reader.push(chunk)) {
      if (frame.type === FRAME_COMMAND) {
        // Handshake replies; some stations repeat them after the key is set, where they are noise.
        if (!this.cipher) this.offer(frame);
        continue;
      }
      if (frame.type !== FRAME_PROTOCOL || !this.cipher) continue;
      let packet: Packet;
      try {
        packet = decodePacket(this.cipher.decrypt(frame.payload));
      } catch (e) {
        this.o.onBadFrame?.(e as Error);
        continue;
      }
      this.o.onPacket?.(packet);
      this.offer(packet);
    }
  }

  private offer(item: Incoming): void {
    if (this.waiter?.accept(item)) this.waiter = null;
  }

  private packetFrame(p: { src: number; dst: number; cmdSet: number; cmdId: number; payload?: Uint8Array }): Buffer {
    if (!this.cipher) throw new SessionError(this.stage, 'no session key');
    return encodeFrame(FRAME_PROTOCOL, this.cipher.encrypt(encodePacket(p)));
  }

  private setStage(stage: SessionStage): void {
    this.stage = stage;
    this.o.onStage?.(stage);
  }

  private exchange<T extends Incoming>(stage: SessionStage, frame: Buffer, match: (f: Incoming) => f is T): Promise<T> {
    this.setStage(stage);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new SessionError(stage, `no reply in ${stage}`)); }, this.o.stageTimeoutMs ?? 15_000);
      this.waiter = {
        accept: f => {
          if (!match(f)) return false;
          clearTimeout(timer);
          resolve(f);
          return true;
        },
      };
      this.send(frame).catch(e => { clearTimeout(timer); this.waiter = null; reject(new SessionError(stage, `write failed: ${e?.message ?? e}`)); });
    });
  }

  /** The only way out: the allow-list above. */
  private async send(frame: Buffer): Promise<void> {
    if (frame[2] >> 4 === FRAME_COMMAND) {
      if (frame[6] !== 0x01 && frame[6] !== 0x02) throw new Error('refusing a non-handshake command frame');
    } else {
      const p = decodePacket(this.cipher!.decrypt(frame.subarray(6, frame.length - 2)));
      const allowed = p.dst === DST_AUTH && p.cmdSet === 0x35 && (p.cmdId === 0x89 || p.cmdId === 0x86);
      if (!allowed) throw new Error(`refusing to send ${p.cmdSet.toString(16)}/${p.cmdId.toString(16)}`);
    }
    return this.o.write(frame);
  }
}
