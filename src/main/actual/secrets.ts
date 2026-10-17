/** Log-safe form of an Access Key: first 4 characters + ellipsis. */
export function maskKey(key: string): string {
  return key.length < 5 ? '…' : `${key.slice(0, 4)}…`;
}
