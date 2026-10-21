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
