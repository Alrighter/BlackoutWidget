import type { Logger } from '../../../src/main/log';
import type { UpdateBackend } from '../../../src/main/update/backend';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UpdateController } from '../../../src/main/update/controller';
import type { UpdateStatus } from '../../../src/shared/types';

beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A backend whose download hands its progress callback and promise to the test. */
function setup(opts: { canInstall?: boolean } = {}) {
  const downloads: { version: string; progress: (p: number) => void; done: Deferred<void> }[] = [];
  const backend = {
    check: vi.fn<() => Promise<string | null>>(async () => null),
    canInstall: vi.fn(() => opts.canInstall ?? true),
    openManual: vi.fn<(v: string) => void>(),
    download: vi.fn((version: string, progress: (p: number) => void) => {
      const done = deferred<void>(); downloads.push({ version, progress, done }); return done.promise;
    }),
    install: vi.fn<() => Promise<void>>(async () => {}),
  } satisfies UpdateBackend;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const seen: UpdateStatus[] = [];
  const c = new UpdateController({ backend, log, onChange: s => seen.push(s) });
  return { c, backend, log, seen, downloads };
}

/** A controller already showing `version` as available. */
async function available(version = '1.0.2', opts: { canInstall?: boolean } = {}) {
  const t = setup(opts);
  t.backend.check.mockResolvedValueOnce(version);
  await t.c.check();
  t.seen.length = 0;
  return t;
}

test('first check after FIRST_CHECK_DELAY_MS, then every CHECK_INTERVAL_MS', async () => {
  const { c, backend } = setup();
  c.start();
  await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1); expect(backend.check).toHaveBeenCalledTimes(0);
  await vi.advanceTimersByTimeAsync(1); expect(backend.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); expect(backend.check).toHaveBeenCalledTimes(2);
  c.stop();
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3); expect(backend.check).toHaveBeenCalledTimes(2);
  expect(FIRST_CHECK_DELAY_MS).toBe(120_000);
  expect(CHECK_INTERVAL_MS).toBe(21_600_000);
});

test('a newer version makes it available; none keeps it idle; a later newer version replaces the offered one', async () => {
  const { c, backend, seen } = setup();
  await c.check();
  expect(c.status()).toEqual({ phase: 'idle' });
  expect(seen).toEqual([]);
  backend.check.mockResolvedValueOnce('1.0.2'); await c.check();
  expect(c.status()).toEqual({ phase: 'available', version: '1.0.2' });
  backend.check.mockResolvedValueOnce('1.0.2'); await c.check();
  backend.check.mockResolvedValueOnce('1.0.3'); await c.check();
  expect(c.status()).toEqual({ phase: 'available', version: '1.0.3' });
  backend.check.mockResolvedValueOnce(null); await c.check();
  expect(c.status()).toEqual({ phase: 'idle' });
  expect(seen).toEqual([
    { phase: 'available', version: '1.0.2' }, { phase: 'available', version: '1.0.3' }, { phase: 'idle' },
  ]);
});

test('a failed check logs one warning, shows nothing and the next interval checks again', async () => {
  const { c, backend, log, seen } = setup();
  backend.check.mockRejectedValueOnce(new Error('offline'));
  c.start();
  await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
  expect(c.status()).toEqual({ phase: 'idle' });
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([]);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(backend.check).toHaveBeenCalledTimes(2);
  c.stop();
});

test('install: available → downloading (integer percents, emitted only on change) → installing → backend.install()', async () => {
  const { c, backend, seen, downloads } = await available();
  const done = c.install();
  expect(backend.download).toHaveBeenCalledWith('1.0.2', expect.any(Function));
  for (const p of [0.4, 0.9, 41.6, 41.9, 100]) downloads[0].progress(p);
  downloads[0].done.resolve();
  await done;
  expect(seen.filter(s => s.phase === 'downloading').map(s => (s as { percent: number }).percent)).toEqual([0, 1, 42, 100]);
  expect(seen.at(-1)).toEqual({ phase: 'installing', version: '1.0.2' });
  expect(backend.install).toHaveBeenCalledTimes(1);
});

test('percent is clamped to 0–100', async () => {
  const { c, seen, downloads } = await available();
  void c.install();
  downloads[0].progress(-5); downloads[0].progress(130);
  expect(seen.map(s => (s as { percent?: number }).percent)).toEqual([0, 100]);
});

test('two clicks start one download; a scheduled check during the download does nothing', async () => {
  const { c, backend } = await available();
  c.start();
  void c.install(); void c.install();
  expect(backend.download).toHaveBeenCalledTimes(1);
  const checks = backend.check.mock.calls.length;
  await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
  expect(backend.check).toHaveBeenCalledTimes(checks);
  expect(c.status()).toEqual({ phase: 'downloading', version: '1.0.2', percent: 0 });
  c.stop();
});

test('a check that answers after the click does not change the download', async () => {
  const { c, backend } = await available();
  const answer = deferred<string | null>();
  backend.check.mockReturnValueOnce(answer.promise);
  const checking = c.check();
  void c.install();
  answer.resolve('1.0.3');
  await checking;
  expect(c.status()).toEqual({ phase: 'downloading', version: '1.0.2', percent: 0 });
});

test('download fails → error with the same version, one error log; a click retries the download', async () => {
  const { c, backend, log, downloads } = await available();
  const first = c.install();
  downloads[0].done.reject(new Error('socket hang up'));
  await first;
  expect(c.status()).toEqual({ phase: 'error', version: '1.0.2' });
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(backend.install).not.toHaveBeenCalled();
  void c.install();
  expect(backend.download).toHaveBeenCalledTimes(2);
  expect(c.status()).toEqual({ phase: 'downloading', version: '1.0.2', percent: 0 });
});

test('a check in error: a newer version offers it, the same version keeps the error', async () => {
  const { c, backend, downloads } = await available();
  const first = c.install();
  downloads[0].done.reject(new Error('x'));
  await first;
  backend.check.mockResolvedValueOnce('1.0.2'); await c.check();
  expect(c.status()).toEqual({ phase: 'error', version: '1.0.2' });
  backend.check.mockResolvedValueOnce('1.0.3'); await c.check();
  expect(c.status()).toEqual({ phase: 'available', version: '1.0.3' });
});

test('install() fails to start → error', async () => {
  const { c, backend, log, downloads } = await available();
  backend.install.mockRejectedValueOnce(new Error('spawn failed'));
  const done = c.install();
  downloads[0].done.resolve();
  await done;
  expect(c.status()).toEqual({ phase: 'error', version: '1.0.2' });
  expect(log.error).toHaveBeenCalledTimes(1);
});

test('idle install does nothing', async () => {
  const { c, backend, seen } = setup();
  await c.install();
  expect(backend.download).not.toHaveBeenCalled();
  expect(backend.openManual).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
});

test('a backend that can\'t install opens the release page and stays available', async () => {
  const { c, backend, seen } = await available('1.0.2', { canInstall: false });
  await c.install();
  expect(backend.openManual).toHaveBeenCalledWith('1.0.2');
  expect(backend.download).not.toHaveBeenCalled();
  expect(c.status()).toEqual({ phase: 'available', version: '1.0.2' });
  expect(seen).toEqual([]);
});
