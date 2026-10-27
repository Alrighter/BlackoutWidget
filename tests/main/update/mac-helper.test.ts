import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_SCRIPT, helperArgs } from '../../../src/main/update/mac-helper';

/** The script is /bin/sh on macOS; here any POSIX sh (Git's on Windows, where it exists). */
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

/** Old.app holding v1, New.app holding v2, the script on disk; `open` is `true`, so nothing launches. */
function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'bw-helper-'));
  const old = join(dir, 'Old.app'); const staged = join(dir, 'stage', 'New.app');
  mkdirSync(join(old, 'v1'), { recursive: true }); mkdirSync(join(staged, 'v2'), { recursive: true });
  const script = join(dir, 'swap.sh'); writeFileSync(script, HELPER_SCRIPT);
  const log = join(dir, 'logs', 'update-helper.log');
  const run = (pid: number, env: Record<string, string> = {}) => spawnSync('sh', [script, ...helperArgs({ pid, bundle: old, staged, log })], {
    env: { ...process.env, BW_OPEN: 'true', ...env }, encoding: 'utf8', timeout: 20_000,
  });
  const logText = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { dir, old, staged, log, run, logText };
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
  });

  test('when the new bundle can\'t be moved in, puts the old one back', () => {
    const s = scene();
    spawnSync('sh', ['-c', `rm -rf "${s.staged.replace(/\\/g, '/')}"`]);
    const r = s.run(999999);
    expect(r.status).toBe(1);
    expect(readdirSync(s.old)).toEqual(['v1']);
    expect(readdirSync(s.dir).filter(n => n.includes('.old-'))).toEqual([]);
    expect(s.logText()).toContain('the new version could not be moved in; the old one is back');
  });

  test.skipIf(process.platform === 'win32')('gives up without touching anything when the app doesn\'t quit', async () => {
    const s = scene();
    const app = spawn('sleep', ['5']);
    try {
      const r = s.run(app.pid as number, { BW_WAIT_S: '1' });
      expect(r.status).toBe(1);
      expect(readdirSync(s.old)).toEqual(['v1']);
      expect(readdirSync(s.staged)).toEqual(['v2']);
      expect(s.logText()).toContain('the app did not quit');
    } finally {
      app.kill();
    }
  });
});
