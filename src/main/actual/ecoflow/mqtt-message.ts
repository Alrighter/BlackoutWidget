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
