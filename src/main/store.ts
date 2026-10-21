import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME_ID, LAST_LOCATION, LIMIT_TEXT, MAX_LOCATIONS, UNKNOWN_LOCATION, isAddress, nameProblem, normalizeName, sameAddress } from '../shared/locations';
import type { Location, ScheduleSnapshot, Settings } from '../shared/types';
import { migrateSettings } from './settings-migration';

export const DEFAULT_SETTINGS: Settings = { locations: [], actualLocationId: null, autostart: true, actualSource: null };
export const READ_RETRIES = 3;
export const READ_RETRY_MS = 50;

export type ReadFile = (path: string) => string;
const readUtf8: ReadFile = path => readFileSync(path, 'utf8');
export type WriteFile = (path: string, text: string) => void;
/** tmp file + rename, so a crash mid-write never leaves a half-written file. */
const writeAtomic: WriteFile = (path, text) => {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JsonStore<T> {
  constructor(private readonly filePath: string, private readonly defaults: T, private readonly readFile: ReadFile = readUtf8, private readonly writeText: WriteFile = writeAtomic) {}

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

  write(value: T): void { this.writeText(this.filePath, JSON.stringify(value, null, 2)); }
}

export class LocationError extends Error {}

type Snapshots = Record<string, ScheduleSnapshot>;
const asRecord = <T extends object>(v: unknown): T => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;

export class AppStore {
  private readonly settings: JsonStore<Record<string, unknown>>;
  private readonly snapshots: JsonStore<Snapshots>;
  private readonly legacySnapshot: JsonStore<ScheduleSnapshot | null>;
  private readonly writeText: WriteFile;
  private readonly newId: () => string;
  private readonly legacyPath: string;
  private lastSettings: Settings | null = null;
  private lastSnapshots: Snapshots = {};
  private loaded = false;

  constructor(dir: string, deps: { readFile?: ReadFile; writeFile?: WriteFile; newId?: () => string } = {}) {
    this.writeText = deps.writeFile ?? writeAtomic;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.settings = new JsonStore<Record<string, unknown>>(join(dir, 'settings.json'), {}, deps.readFile, this.writeText);
    this.snapshots = new JsonStore<Snapshots>(join(dir, 'snapshots.json'), {}, deps.readFile, this.writeText);
    this.legacySnapshot = new JsonStore<ScheduleSnapshot | null>(join(dir, 'snapshot.json'), null, deps.readFile, this.writeText);
    this.legacyPath = join(dir, 'snapshot.json');
  }

  /** True once a read of settings.json has succeeded (a missing file counts); after that it stays true. */
  get settingsLoaded(): boolean { return this.loaded; }

  /** Never throws: while the file cannot be read, the last settings read or written (else defaults) — for display only. */
  getSettings(): Settings {
    try {
      return this.readSettings();
    } catch {
      return structuredClone(this.lastSettings ?? DEFAULT_SETTINGS);
    }
  }

  /** Throws — and writes nothing — when the current settings cannot be read: real settings are never replaced by defaults. */
  updateSettings(patch: Partial<Omit<Settings, 'locations'>>): Settings {
    return this.change(s => ({ ...s, ...patch }));
  }

  getLocation(id: string): Location | null { return this.getSettings().locations.find(l => l.id === id) ?? null; }

  /** Read, validate and write in one synchronous step, so no other writer's change is lost in between. */
  addLocation(input: Omit<Location, 'id'>): Location {
    let added!: Location;
    this.change(s => {
      if (s.locations.length >= MAX_LOCATIONS) throw new LocationError(LIMIT_TEXT);
      const name = normalizeName(input.name);
      const problem = nameProblem(name, s.locations.map(l => l.name));
      if (problem) throw new LocationError(problem);
      added = { ...input, name, id: this.newId() };
      return { ...s, locations: [...s.locations, added], actualLocationId: s.locations.length === 0 ? added.id : s.actualLocationId };
    });
    return added;
  }

  /** `fn` gets a copy of the freshly read location; whatever it does to `id` is undone. */
  updateLocation(id: string, fn: (l: Location) => Location): Location {
    let updated!: Location;
    this.change(s => {
      const old = s.locations.find(l => l.id === id);
      if (!old) throw new LocationError(UNKNOWN_LOCATION);
      const next = fn(structuredClone(old));
      const name = normalizeName(next.name);
      const problem = nameProblem(name, s.locations.filter(l => l.id !== id).map(l => l.name));
      if (problem) throw new LocationError(problem);
      updated = { ...next, name, id };
      return { ...s, locations: s.locations.map(l => (l.id === id ? updated : l)) };
    });
    return updated;
  }

  removeLocation(id: string): void {
    this.change(s => {
      if (!s.locations.some(l => l.id === id)) throw new LocationError(UNKNOWN_LOCATION);
      if (s.locations.length <= 1) throw new LocationError(LAST_LOCATION);
      return { ...s, locations: s.locations.filter(l => l.id !== id), actualLocationId: s.actualLocationId === id ? null : s.actualLocationId };
    });
    try { this.setSnapshot(id, null); } catch { /* an orphaned entry is harmless: ids are never reused */ }
  }

  /** Never throws: while the file cannot be read, the last snapshots read or written. */
  getSnapshot(id: string): ScheduleSnapshot | null {
    try {
      this.lastSnapshots = asRecord<Snapshots>(this.snapshots.read());
    } catch { /* keep the last ones */ }
    return this.lastSnapshots[id] ?? null;
  }

  /** null drops the entry (used when the address changes or the location is deleted). Throws if the cache cannot be read: other entries are never replaced. */
  setSnapshot(id: string, s: ScheduleSnapshot | null): void {
    const all = asRecord<Snapshots>(this.snapshots.read());
    if (s) all[id] = s; else delete all[id];
    this.snapshots.write(all);
    this.lastSnapshots = all;
  }

  private change(fn: (s: Settings) => Settings): Settings {
    const next = fn(this.readSettings());
    this.settings.write(next as unknown as Record<string, unknown>);
    this.lastSettings = next;
    return next;
  }

  private readSettings(): Settings {
    const { settings, migrated } = migrateSettings(asRecord(this.settings.read()));
    this.loaded = true;
    this.lastSettings = settings;
    if (migrated) this.persistMigration(settings);
    return structuredClone(settings);
  }

  /**
   * Best effort: a failure here is swallowed, the in-memory result is used and the next write carries it. The old
   * snapshot.json goes only after both new files are on disk.
   */
  private persistMigration(settings: Settings): void {
    try {
      const home = settings.locations.find(l => l.id === HOME_ID);
      const cache = asRecord<Snapshots>(this.snapshots.read());
      const old = this.legacySnapshot.read();
      // A malformed snapshot.json (valid JSON, no address) is not carried; it must not stop the migration either.
      if (home && !cache[HOME_ID] && old && isAddress(old.address) && sameAddress(home.address, old.address)) {
        this.snapshots.write({ ...cache, [HOME_ID]: old });
      }
      this.settings.write(settings as unknown as Record<string, unknown>);
      rmSync(this.legacyPath, { force: true });
    } catch { /* retried by the next read */ }
  }
}
