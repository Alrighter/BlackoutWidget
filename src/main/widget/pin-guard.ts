import { silentLogger, type Logger } from '../log';

/** The marker file, in Electron's userData directory. */
export const PIN_GUARD_FILE = 'pin-darwin.pending';

/** The synchronous fs calls the guard needs; `node:fs` satisfies it, tests pass an in-memory one. */
export interface PinGuardFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export interface PinGuardRunOptions {
  /**
   * After `fn` returns normally, keep the marker this many ms longer: AppKit acts on some calls (a new window level, a
   * layer's corner mask) in the run-loop cycles after them, and a crash there must count too. Later runs never cut an
   * earlier hold short.
   */
  holdMs?: number;
}

export interface PinGuard {
  /** True when the previous run of this version died inside a guarded native call: don't make native calls again. */
  readonly disabled: boolean;
  /** Runs `fn` with the marker on disk; throws (without running `fn`) when disabled or the marker can't be written. */
  run<T>(fn: () => T, opts?: PinGuardRunOptions): T;
  /** App quit: removes a marker still held after a good run, at once. Does nothing when no hold is pending; never throws. */
  release(): void;
}

/**
 * Crash guard for native calls that try/catch can't protect (a wrong FFI signature kills the process). The marker
 * holding the app version is written before the native calls and removed after (or `holdMs` later), so a marker left
 * behind at start means the process died mid-call. One crash then turns the guarded feature off for that version; a new
 * version tries again. A marker of the same version is kept, so the app doesn't crash on every other launch.
 */
export function createPinGuard(fs: PinGuardFs, file: string, version: string, log: Logger = silentLogger): PinGuard {
  let disabled = false;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8').trim() === version) disabled = true;
    else fs.rmSync(file, { force: true }); // another version's (or a garbled) marker: that version may have been the culprit
  }

  let heldUntil = 0; // Date.now() at which the current hold ends; 0 = none
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  // Never throws: a marker that can't be removed must not turn a good native call into a reported failure (or a
  // throwing timer into an error dialog). Left behind, it turns the feature off at the next start of this version.
  const remove = () => {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      log.error(`could not remove the crash marker ${file}; if it stays, the next start of ${version} turns macOS native calls off`, err);
    }
  };

  const release = () => {
    if (holdTimer === undefined) return;
    clearTimeout(holdTimer);
    holdTimer = undefined;
    heldUntil = 0;
    remove();
  };

  const hold = (ms: number) => {
    const until = Date.now() + ms;
    if (until <= heldUntil) return;
    heldUntil = until;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(release, ms);
    holdTimer.unref?.(); // never keeps the process alive on its own
  };

  return {
    disabled,
    run<T>(fn: () => T, opts: PinGuardRunOptions = {}): T {
      if (disabled) throw new Error(`native calls disabled by the crash marker ${file}`);
      fs.writeFileSync(file, version); // throws before fn: native code never runs unguarded
      let done = false;
      try {
        const result = fn();
        done = true;
        return result;
      } finally {
        if (done && opts.holdMs) hold(opts.holdMs);
        if (Date.now() >= heldUntil) remove(); // still inside an earlier (or this) hold: its timer removes the marker
      }
    },
    release,
  };
}
