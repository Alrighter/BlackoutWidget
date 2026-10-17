import { RefreshScheduler, type RunOutcome } from '../../src/main/scheduler';

beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
const min = 60_000;
const always = (o: RunOutcome) => vi.fn(async (): Promise<RunOutcome> => o);
test('runs at start, then every 15 min (random 0.5 → no jitter)', async () => {
  const run = always('ok'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
test('jitter bounds: random 0 → 14 min, random 1 → 16 min', async () => {
  for (const [r, m] of [[0, 14], [1, 16]] as const) {
    const run = always('ok'); const s = new RefreshScheduler(run, { random: () => r }); s.start();
    await vi.advanceTimersByTimeAsync(m * min - 1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); s.stop();
  }
});
test('offline (never reached the source): backoff 1,2,4,8,15,15 min', async () => {
  const run = always('offline'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const [i, m] of [1, 2, 4, 8, 15, 15].entries()) {
    await vi.advanceTimersByTimeAsync(m * min - 1); expect(run).toHaveBeenCalledTimes(i + 1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(i + 2);
  }
});
test('failed (reached the source): never again within 5 min of the previous start, then backoff 8,15', async () => {
  const run = always('failed'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const [i, m] of [5, 5, 5, 8, 15].entries()) {
    await vi.advanceTimersByTimeAsync(m * min - 1); expect(run).toHaveBeenCalledTimes(i + 1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(i + 2);
  }
});
test('failed after a slow run: the 5-min floor counts from the start of that run', async () => {
  const run = vi.fn((): Promise<RunOutcome> => new Promise(r => setTimeout(() => r('failed'), 2 * min)));
  const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
test('resume within 5 min of last run waits until the 5-min mark; later runs immediately', async () => {
  const run = always('ok'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(2 * min); s.trigger('resume');
  await vi.advanceTimersByTimeAsync(3 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * min); s.trigger('online');
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(3);
});
test('online right after an offline failure runs immediately; resume still waits for the gap', async () => {
  const run = always('offline'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(1);
  s.trigger('online'); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
  const r = always('offline'); const t = new RefreshScheduler(r, { random: () => 0.5 }); t.start();
  await vi.advanceTimersByTimeAsync(7 * min); expect(r).toHaveBeenCalledTimes(4); // at 0, 1, 3, 7 min; next due at 15
  await vi.advanceTimersByTimeAsync(30_000); t.trigger('resume');
  await vi.advanceTimersByTimeAsync(4.5 * min - 1); expect(r).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1); expect(r).toHaveBeenCalledTimes(5); // 7 + 5 min, not right away
  s.stop(); t.stop();
});
test('online after a failure that reached the source still waits for the 5-min gap', async () => {
  const run = always('failed'); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(30_000); s.trigger('online');
  await vi.advanceTimersByTimeAsync(4.5 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
test('manual runs immediately even 1 min after a run (also after a failure that reached the source)', async () => {
  const run = always('ok'); const s = new RefreshScheduler(run); s.start();
  await vi.advanceTimersByTimeAsync(min); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  const f = always('failed'); const t = new RefreshScheduler(f); t.start();
  await vi.advanceTimersByTimeAsync(min); t.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(f).toHaveBeenCalledTimes(2);
  s.stop(); t.stop();
});
test('no parallel runs', async () => {
  let release!: () => void; const run = vi.fn(() => new Promise<RunOutcome>(r => (release = () => r('ok'))));
  const s = new RefreshScheduler(run); s.start(); await vi.advanceTimersByTimeAsync(0);
  s.trigger('manual'); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1); release();
});
test('a throwing run counts as a failure that reached the source (5-min floor), no unhandled rejection', async () => {
  const run = vi.fn(async (): Promise<RunOutcome> => { throw new Error('boom'); });
  const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
