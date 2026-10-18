/** The marker file, in Electron's userData directory. */
export const PIN_GUARD_FILE = 'pin-darwin.pending';

/** The synchronous fs calls the guard needs; `node:fs` satisfies it, tests pass an in-memory one. */
export interface PinGuardFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export interface PinGuard {
  /** True when the previous run of this version died inside a guarded native call: don't make native calls again. */
  readonly disabled: boolean;
  /** Runs `fn` with the marker on disk; throws (without running `fn`) when disabled or the marker can't be written. */
  run<T>(fn: () => T): T;
}

/**
 * Crash guard for native calls that try/catch can't protect (a wrong FFI signature kills the process). The marker
 * holding the app version is written before the native calls and removed after, so a marker left behind at start
 * means the process died mid-call. One crash then turns the guarded feature off for that version; a new version
 * tries again. A marker of the same version is kept, so the app doesn't crash on every other launch.
 */
export function createPinGuard(fs: PinGuardFs, file: string, version: string): PinGuard {
  let disabled = false;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8').trim() === version) disabled = true;
    else fs.rmSync(file, { force: true }); // another version's (or a garbled) marker: that version may have been the culprit
  }
  return {
    disabled,
    run<T>(fn: () => T): T {
      if (disabled) throw new Error(`native calls disabled by the crash marker ${file}`);
      fs.writeFileSync(file, version); // throws before fn: native code never runs unguarded
      try {
        return fn();
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
}
