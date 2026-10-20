import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// A smoke script's throwaway profile, never the app's (or Electron's default) user data. The prefix names the script:
// `bw-smoke-<name>-`; only a folder right under the temp folder whose name starts with it is ever deleted.

const PREFIX_RE = /^bw-smoke-[a-z]+-$/;

const isSmokeProfile = (dir: string, prefix: string): boolean =>
  PREFIX_RE.test(prefix) && dirname(resolve(dir)) === resolve(tmpdir())
  && basename(dir).startsWith(prefix) && basename(dir).length > prefix.length;

export function makeSmokeProfile(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) throw new Error(`not a smoke profile prefix: ${prefix}`);
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The detached cleanup (`node -e`, args: folder, prefix): the same check as isSmokeProfile, then 40 tries 250 ms apart. */
export const RETRY_SCRIPT = `const { rmSync } = require('node:fs'); const { tmpdir } = require('node:os');
const { basename, dirname, resolve } = require('node:path');
const [dir, prefix] = process.argv.slice(1);
const ok = typeof dir === 'string' && /^bw-smoke-[a-z]+-$/.test(prefix ?? '') && dirname(resolve(dir)) === resolve(tmpdir())
  && basename(dir).startsWith(prefix) && basename(dir).length > prefix.length;
if (ok) {
  let n = 0;
  const t = setInterval(() => {
    try { rmSync(dir, { recursive: true, force: true }); clearInterval(t); } catch { if (++n >= 40) clearInterval(t); }
  }, 250);
}`;

/**
 * Chromium's helper processes (GPU, network) keep files of the profile open until the app is gone, so on Windows the
 * folder often cannot be removed from inside. Then a detached Node (Electron run as Node, no window) retries for 10 s;
 * it checks the folder again itself before deleting anything. Call this before app.exit: exit ends the process.
 */
export function removeSmokeProfile(profile: string, prefix: string): void {
  if (!isSmokeProfile(profile, prefix)) return;
  try {
    rmSync(profile, { recursive: true, force: true });
    return;
  } catch { /* still held */ }
  spawn(process.execPath, ['-e', RETRY_SCRIPT, profile, prefix], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}
