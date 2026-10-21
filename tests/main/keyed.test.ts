import { guardedKeyed, Keyed } from '../../src/main/keyed';

function setup() {
  const log: string[] = [];
  const keyed = new Keyed<{ id: string }>(id => { log.push(`+${id}`); return { id }; }, (_item, id) => { log.push(`-${id}`); });
  return { keyed, log };
}
test('sync creates the items in order', () => {
  const { keyed, log } = setup();
  keyed.sync(['a', 'b']);
  expect(log).toEqual(['+a', '+b']);
  expect(keyed.ids()).toEqual(['a', 'b']);
  expect(keyed.values().map(v => v.id)).toEqual(['a', 'b']);
});
test('sync disposes what left, keeps what stayed and creates what came', () => {
  const { keyed, log } = setup();
  keyed.sync(['a', 'b']);
  const b = keyed.get('b');
  log.length = 0;
  keyed.sync(['b', 'c']);
  expect(log).toEqual(['-a', '+c']);
  expect(keyed.get('b')).toBe(b);
  expect(keyed.get('a')).toBeUndefined();
});
test('clear disposes everything', () => {
  const { keyed, log } = setup();
  keyed.sync(['b', 'c']);
  log.length = 0;
  keyed.clear();
  expect(log).toEqual(['-b', '-c']);
  expect(keyed.ids()).toEqual([]);
});

describe('guardedKeyed', () => {
  test('a create that throws holds null, is logged by id, and the others are still built', () => {
    const log = { error: vi.fn() };
    const events: string[] = [];
    const keyed = guardedKeyed<{ id: string }>(
      log, 'widget',
      id => { if (id === 'b') throw new Error('no window'); events.push(`+${id}`); return { id }; },
      (_item, id) => { events.push(`-${id}`); },
    );
    expect(() => keyed.sync(['a', 'b', 'c'])).not.toThrow();
    expect(events).toEqual(['+a', '+c']);
    expect(keyed.ids()).toEqual(['a', 'b', 'c']);
    expect(keyed.get('b')).toBeNull();
    expect(keyed.values().map(v => v?.id ?? null)).toEqual(['a', null, 'c']);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toBe('widget: could not be built for location b');
    // Not retried while its id stays; disposing the null entry does nothing.
    keyed.sync(['a', 'b', 'c']);
    expect(log.error).toHaveBeenCalledTimes(1);
    keyed.sync(['a', 'c']);
    expect(events).toEqual(['+a', '+c']);
  });

  test('a dispose that throws is logged by id, and the others still go', () => {
    const log = { error: vi.fn() };
    const gone: string[] = [];
    const keyed = guardedKeyed<{ id: string }>(log, 'scheduler', id => ({ id }), (_item, id) => {
      if (id === 'b') throw new Error('stuck');
      gone.push(id);
    });
    keyed.sync(['a', 'b', 'c']);
    expect(() => keyed.sync(['c'])).not.toThrow();
    expect(keyed.ids()).toEqual(['c']);
    expect(gone).toEqual(['a']);
    expect(log.error).toHaveBeenCalledWith('scheduler: could not be disposed for location b', expect.any(Error));
    expect(() => keyed.clear()).not.toThrow();
    expect(gone).toEqual(['a', 'c']);
  });
});
