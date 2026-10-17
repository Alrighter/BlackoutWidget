import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScheduleSnapshot, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = { address: null, widgetStyle: 'compact', autostart: true, widgetPosition: null };

export class JsonStore<T> {
  constructor(private readonly filePath: string, private readonly defaults: T) {}

  read(): T {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as T;
    } catch {
      return structuredClone(this.defaults);
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

  constructor(dir: string) {
    this.settings = new JsonStore(join(dir, 'settings.json'), DEFAULT_SETTINGS);
    this.snapshot = new JsonStore<ScheduleSnapshot | null>(join(dir, 'snapshot.json'), null);
  }

  getSettings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.settings.read() };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    this.settings.write(next);
    return next;
  }

  getSnapshot(): ScheduleSnapshot | null {
    return this.snapshot.read();
  }

  /** null clears the cached snapshot (used when the address changes). */
  setSnapshot(s: ScheduleSnapshot | null): void {
    this.snapshot.write(s);
  }
}
