import { Keyed } from '../../src/main/keyed';

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
