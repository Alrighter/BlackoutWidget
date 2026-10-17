import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScheduleSnapshot, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = { address: null, widgetStyle: 'compact', autostart: true, widgetPosition: null };
export const READ_RETRIES = 3;
export const READ_RETRY_MS = 50;

export type ReadFile = (path: string) => string;
const readUtf8: ReadFile = path => readFileSync(path, 'utf8');

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JsonStore<T> {
  constructor(private readonly filePath: string, private readonly defaults: T, private readonly readFile: ReadFile = readUtf8) {}

  /**
   * Missing file (ENOENT) or corrupt JSON → defaults. Any other read error (EBUSY, EPERM, …) is retried briefly and
   * then thrown, so a caller about to write can never mistake a locked file for an empty one.
   */
  read(): T {
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = this.readFile(this.filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return structuredClone(this.defaults);
        if (attempt >= READ_RETRIES) throw err;
        sleepSync(READ_RETRY_MS);
        continue;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return structuredClone(this.defaults);
      }
    }
  }

  write(value: T): void {
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

export class AppStore {
  private readonly settings: JsonStore<Settings>;
  private readonly snapshot: JsonStore<ScheduleSnapshot | null>;
  private lastSettings: Settings | null = null;
  private lastSnapshot: ScheduleSnapshot | null = null;

  constructor(dir: string, deps: { readFile?: ReadFile } = {}) {
    this.settings = new JsonStore(join(dir, 'settings.json'), DEFAULT_SETTINGS, deps.readFile);
    this.snapshot = new JsonStore<ScheduleSnapshot | null>(join(dir, 'snapshot.json'), null, deps.readFile);
  }

  /** Never throws: while the file cannot be read, the last settings read or written (else defaults) — for display only. */
  getSettings(): Settings {
    try {
      return this.readSettings();
    } catch {
      return { ...(this.lastSettings ?? DEFAULT_SETTINGS) };
    }
  }

  /** Throws — and writes nothing — when the current settings cannot be read: real settings are never replaced by defaults. */
  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.readSettings(), ...patch };
    this.settings.write(next);
    this.lastSettings = next;
    return next;
  }

  /** Never throws: while the file cannot be read, the last snapshot read or written. */
  getSnapshot(): ScheduleSnapshot | null {
    try {
      this.lastSnapshot = this.snapshot.read();
    } catch { /* keep the last one */ }
    return this.lastSnapshot;
  }

  /** null clears the cached snapshot (used when the address changes). */
  setSnapshot(s: ScheduleSnapshot | null): void {
    this.snapshot.write(s);
    this.lastSnapshot = s;
  }

  private readSettings(): Settings {
    const s = { ...DEFAULT_SETTINGS, ...this.settings.read() };
    this.lastSettings = s;
    return s;
  }
}
