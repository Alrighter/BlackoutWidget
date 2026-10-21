/** One item per id (a scheduler, a widget window): `sync` makes the set match the ids, creating and disposing as needed. */
export class Keyed<T> {
  private items = new Map<string, T>();

  constructor(private readonly create: (id: string) => T, private readonly dispose: (item: T, id: string) => void) {}

  sync(ids: string[]): void {
    const wanted = new Set(ids);
    for (const [id, item] of this.items) if (!wanted.has(id)) this.dispose(item, id);
    const next = new Map<string, T>();
    for (const id of wanted) {
      const kept = this.items.get(id);
      next.set(id, kept !== undefined ? kept : this.create(id));
    }
    this.items = next;
  }

  get(id: string): T | undefined { return this.items.get(id); }
  ids(): string[] { return [...this.items.keys()]; }
  values(): T[] { return [...this.items.values()]; }

  clear(): void {
    const old = this.items;
    this.items = new Map();
    for (const [id, item] of old) this.dispose(item, id);
  }
}

/**
 * A Keyed whose callbacks never throw: a throw inside sync would leave the set half-built, and every later publish
 * would hit it again. A create that throws is logged (by id only) and holds null until its id leaves, a dispose that
 * throws is logged and the item is gone all the same.
 */
export function guardedKeyed<T>(
  log: { error(message: string, err?: unknown): void }, what: string,
  create: (id: string) => T, dispose: (item: T, id: string) => void,
): Keyed<T | null> {
  return new Keyed<T | null>(
    id => {
      try {
        return create(id);
      } catch (err) {
        log.error(`${what}: could not be built for location ${id}`, err);
        return null;
      }
    },
    (item, id) => {
      if (item === null) return;
      try {
        dispose(item, id);
      } catch (err) {
        log.error(`${what}: could not be disposed for location ${id}`, err);
      }
    },
  );
}
