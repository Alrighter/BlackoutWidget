/** Minimal logging contract. Pure modules never log to disk themselves; they get a Logger injected (or report via return values). */
export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, err?: unknown): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** For the smoke script and other dev tools: never touches the disk. */
export const consoleLogger: Logger = {
  info: (m, d) => console.log(formatLogLine(new Date(), 'INFO', m, d).trimEnd()),
  warn: (m, d) => console.warn(formatLogLine(new Date(), 'WARN', m, d).trimEnd()),
  error: (m, e) => console.error(formatLogLine(new Date(), 'ERROR', m, e).trimEnd()),
};

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** "Name: message" plus the whole `cause` chain; the stack of the outermost error only when asked. */
export function describeError(err: unknown, opts: { stack?: boolean } = {}): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    if (cur instanceof Error) {
      parts.push(depth === 0 && opts.stack && cur.stack ? cur.stack : `${cur.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(typeof cur === 'string' ? cur : safeJson(cur));
      break;
    }
  }
  return parts.join('\n  caused by: ');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (x instanceof Error ? describeError(x) : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

/** One log line (with trailing newline): `ISO LEVEL message data`. Errors are described with their causes. */
export function formatLogLine(at: Date, level: LogLevel, message: string, data?: unknown): string {
  let tail = '';
  if (data instanceof Error) tail = ' ' + describeError(data, { stack: level === 'ERROR' });
  else if (data !== undefined) tail = ' ' + (typeof data === 'string' ? data : safeJson(data));
  return `${at.toISOString()} ${level} ${message}${tail}\n`;
}
