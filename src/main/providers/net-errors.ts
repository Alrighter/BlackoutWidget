// Chromium net error codes that mean the connection itself could not be made (no DTEK contact).
const CONNECTIVITY_CODES = new Set([
  -106, // ERR_INTERNET_DISCONNECTED
  -105, // ERR_NAME_NOT_RESOLVED
  -137, // ERR_NAME_RESOLUTION_FAILED
  -102, // ERR_CONNECTION_REFUSED
  -109, // ERR_ADDRESS_UNREACHABLE
  -118, // ERR_CONNECTION_TIMED_OUT
  -21, //  ERR_NETWORK_CHANGED
  -130, // ERR_PROXY_CONNECTION_FAILED
]);

/**
 * Whether a failed main-frame load means "no connection" (quick offline backoff) rather than "the site was reached
 * but failed" (e.g. ERR_EMPTY_RESPONSE, ERR_CONNECTION_RESET, ERR_TIMED_OUT, or our own ERR_BLOCKED_BY_CLIENT).
 */
export function isConnectivityError(code: number, online: boolean): boolean {
  return !online || CONNECTIVITY_CODES.has(code);
}
