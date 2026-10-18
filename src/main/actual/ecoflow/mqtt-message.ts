const TYPE_PREFIX: Record<string, string> = {
  pdStatus: 'pd.',
  mpptStatus: 'mppt.',
  invStatus: 'inv.',
  bmsStatus: 'bms_bmsStatus.',
  emsStatus: 'bms_emsStatus.',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Folds a partial /quota message into the same flat keys as quota/all; null when it carries no readings.
export function normalizeQuotaMessage(msg: unknown): Record<string, unknown> | null {
  if (!isObj(msg)) return null;
  const body = isObj(msg.params) ? msg.params : isObj(msg.param) ? msg.param : null;
  if (!body) return null;

  let prefix = '';
  if (typeof msg.typeCode === 'string') prefix = TYPE_PREFIX[msg.typeCode] ?? `${msg.typeCode.replace(/Status$/, '')}.`;
  else if (msg.cmdFunc !== undefined && msg.cmdId !== undefined) prefix = `${msg.cmdFunc}_${msg.cmdId}.`;
  else if (typeof msg.addr === 'string') prefix = `${msg.addr}.`;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[prefix + k] = v;
  return out;
}

export function parseStatusMessage(msg: unknown): boolean | null {
  if (!isObj(msg) || !isObj(msg.params)) return null;
  const s = msg.params.status;
  return s === 1 ? true : s === 0 ? false : null;
}

/**
 * A successful `latestQuotas` answer on the app broker's get_reply topic (R§3.6), else null. An offline station's
 * quotaMap, if any, is not taken: tolwi drops it too.
 */
export function parseGetReply(msg: unknown): { online: boolean; quota: Record<string, unknown> | null } | null {
  if (!isObj(msg) || msg.operateType !== 'latestQuotas' || String(msg.code) !== '0' || !isObj(msg.data)) return null;
  const online = Number(msg.data.online) === 1;
  return { online, quota: online && isObj(msg.data.quotaMap) ? msg.data.quotaMap : null };
}

/**
 * The payload as a JSON object, else null. On the app broker null means a model this source cannot read: newer models
 * speak protobuf there (R§5.3), typically starting with 0x0a.
 */
export function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The app's "get all" request, byte for byte as the Android app sends it (R§3.6). */
export function latestQuotasRequest(now: number): string {
  return JSON.stringify({ from: 'Android', id: String(now), moduleType: 0, operateType: 'latestQuotas', params: {}, version: '1.1' });
}
