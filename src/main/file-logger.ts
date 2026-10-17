import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatLogLine, type Logger, type LogLevel } from './log';

export const LOG_FILE = 'app.log';
export const LOG_FILE_PREV = 'app.log.1';
export const LOG_MAX_BYTES = 1_000_000;

/**
 * Appends to `<dir>/app.log`; when the next line would push it past `maxBytes`, the file becomes `app.log.1`
 * (replacing the previous one) and a new `app.log` starts. Never throws: logging must not take the app down.
 */
export class FileLogger implements Logger {
  private size: number | null = null;
  private readonly file: string;
  private readonly prev: string;
  private readonly maxBytes: number;
  private readonly mirror: boolean;

  constructor(private readonly dir: string, opts: { maxBytes?: number; mirrorToConsole?: boolean } = {}) {
    this.file = join(dir, LOG_FILE);
    this.prev = join(dir, LOG_FILE_PREV);
    this.maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
    this.mirror = opts.mirrorToConsole ?? true;
  }

  get path(): string {
    return this.file;
  }

  info(message: string, data?: unknown): void { this.write('INFO', message, data); }
  warn(message: string, data?: unknown): void { this.write('WARN', message, data); }
  error(message: string, err?: unknown): void { this.write('ERROR', message, err); }

  private write(level: LogLevel, message: string, data: unknown): void {
    let line: string;
    try {
      line = formatLogLine(new Date(), level, message, data);
    } catch {
      return;
    }
    if (this.mirror) {
      try { (level === 'ERROR' ? console.error : console.log)(line.trimEnd()); } catch { /* ignore */ }
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.size === null) this.size = fileSize(this.file);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        try {
          renameSync(this.file, this.prev);
          this.size = 0;
        } catch { /* keep appending to the current file rather than lose the line */ }
      }
      appendFileSync(this.file, line, 'utf8');
      this.size += bytes;
    } catch {
      this.size = null; // re-stat next time
    }
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
