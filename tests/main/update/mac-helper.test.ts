import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_SCRIPT, helperArgs } from '../../../src/main/update/mac-helper';

/** The script is /bin/sh on macOS; here any POSIX sh (Git's on Windows, where it exists). */
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const posix = (p: string) => p.replace(/\\/g, '/');

/**
 * Old.app holding v1, New.app holding v2, the script on disk. `open` is a script that records what it was asked to
 * open, so nothing launches.
 */
function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'bw-helper-'));
  const old = join(dir, 'Old.app'); const staged = join(dir, 'stage', 'New.app');
  mkdirSync(join(old, 'v1'), { recursive: true }); mkdirSync(join(staged, 'v2'), { recursive: true });
  const script = join(dir, 'swap.sh'); writeFileSync(script, HELPER_SCRIPT);
  const log = join(dir, 'logs', 'update-helper.log');
  const openedFile = join(dir, 'opened.txt');
  const opener = join(dir, 'open.sh');
  writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${posix(openedFile)}"\n`, { mode: 0o755 });
  const env = (extra: Record<string, string>) => ({ ...process.env, BW_OPEN: posix(opener), ...extra });
  const rest = helperArgs({ pid: 0, bundle: old, staged, log }).slice(1);
  const run = (pid: number, extra: Record<string, string> = {}) =>
    spawnSync('sh', [script, String(pid), ...rest], { env: env(extra), encoding: 'utf8', timeout: 20_000 });
  /** With the pid of a live `sleep 5` started by the same sh, so `kill -0` sees it on any POSIX sh. */
  const runWhileAlive = (extra: Record<string, string> = {}) => spawnSync('sh', [
    '-c', 'sleep 5 & app=$!; sh "$0" "$app" "$@"; s=$?; kill "$app" 2>/dev/null; exit "$s"', script, ...rest,
  ], { env: env(extra), encoding: 'utf8', timeout: 20_000 });
  const logText = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const opened = () => (existsSync(openedFile) ? readFileSync(openedFile, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, old, staged, log, run, runWhileAlive, logText, opened };
}

test('helperArgs: pid, bundle, staged app and log, as strings', () => {
  expect(helperArgs({ pid: 42, bundle: '/Applications/Blackout Widget.app', staged: '/tmp/s/Blackout Widget.app', log: '/u/logs/h.log' }))
    .toEqual(['42', '/Applications/Blackout Widget.app', '/tmp/s/Blackout Widget.app', '/u/logs/h.log']);
});

describe.skipIf(!hasSh)('the swap helper', () => {
  test('swaps the bundles and opens the new one', () => {
    const s = scene();
    const r = s.run(999999);
    expect(r.status).toBe(0);
    expect(readdirSync(s.old)).toEqual(['v2']);
    expect(existsSync(s.staged)).toBe(false);
    expect(readdirSync(s.dir).filter(n => n.includes('.old-'))).toEqual([]);
    expect(s.opened()).toEqual([s.old]);
  });

  test('when the new bundle can\'t be moved in, puts the old one back and opens it', () => {
    const s = scene();
    spawnSync('sh', ['-c', `rm -rf "${posix(s.staged)}"`]);
    const r = s.run(999999);
    expect(r.status).toBe(1);
    expect(readdirSync(s.old)).toEqual(['v1']);
    expect(readdirSync(s.dir).filter(n => n.includes('.old-'))).toEqual([]);
    expect(s.logText()).toContain('the new version could not be moved in; the old one is back');
    expect(s.opened()).toEqual([s.old]);
  });

  test('gives up without touching anything when the app doesn\'t quit, and opens it, should it quit late', () => {
    const s = scene();
    const r = s.runWhileAlive({ BW_WAIT_S: '1' });
    expect(r.status).toBe(1);
    expect(readdirSync(s.old)).toEqual(['v1']);
    expect(readdirSync(s.staged)).toEqual(['v2']);
    expect(s.logText()).toContain('the app did not quit');
    expect(s.opened()).toEqual([s.old]);
  });
});
