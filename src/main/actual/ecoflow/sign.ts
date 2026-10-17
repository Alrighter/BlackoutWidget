import { createHmac } from 'node:crypto';

function walk(value: unknown, path: string, out: [string, string][]): void {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, out);
  } else out.push([path, String(value)]);
}

/** EcoFlow canonical form: leaves flattened to `a.b=1` / `c[0]=2`, sorted by key in ASCII order, no URL encoding. */
export function flattenParams(params: Record<string, unknown>): string {
  const pairs: [string, string][] = [];
  walk(params, '', pairs);
  return pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signString(params: Record<string, unknown> | undefined, accessKey: string, nonce: string, timestamp: string): string {
  const tail = `accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const head = params ? flattenParams(params) : '';
  return head ? `${head}&${tail}` : tail;
}

export function hmacHex(message: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(message).digest('hex');
}
