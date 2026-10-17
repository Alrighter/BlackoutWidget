import { RefreshScheduler } from '../../src/main/scheduler';

beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
const min = 60_000;
test('runs at start, then every 15 min (random 0.5 → no jitter)', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
test('jitter bounds: random 0 → 14 min, random 1 → 16 min', async () => {
  for (const [r, m] of [[0, 14], [1, 16]] as const) {
    const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => r }); s.start();
    await vi.advanceTimersByTimeAsync(m * min - 1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); s.stop();
  }
});
test('backoff 1,2,4,8,15,15 min on failures', async () => {
  const run = vi.fn(async () => false); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const [i, m] of [1, 2, 4, 8, 15, 15].entries()) { await vi.advanceTimersByTimeAsync(m * min); expect(run).toHaveBeenCalledTimes(i + 2); }
});
test('resume within 5 min of last run waits until the 5-min mark; later runs immediately', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(2 * min); s.trigger('resume');
  await vi.advanceTimersByTimeAsync(3 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * min); s.trigger('online');
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(3);
});
test('manual runs immediately even 1 min after a run', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run); s.start();
  await vi.advanceTimersByTimeAsync(min); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
});
test('no parallel runs', async () => {
  let release!: () => void; const run = vi.fn(() => new Promise<boolean>(r => (release = () => r(true))));
  const s = new RefreshScheduler(run); s.start(); await vi.advanceTimersByTimeAsync(0);
  s.trigger('manual'); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1); release();
});
test('a throwing run counts as failure (backoff), no unhandled rejection', async () => {
  const run = vi.fn(async (): Promise<boolean> => { throw new Error('boom'); });
  const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(min); expect(run).toHaveBeenCalledTimes(2);
});
