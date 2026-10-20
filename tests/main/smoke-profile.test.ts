import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETRY_SCRIPT, makeSmokeProfile, removeSmokeProfile } from '../../src/main/smoke-profile';

const PREFIX = 'bw-smoke-test-';
const made: string[] = [];
const dir = (prefix: string, parent = tmpdir()) => {
  const d = mkdtempSync(join(parent, prefix));
  made.push(d);
  return d;
};
/** The detached cleanup run in the foreground: it exits on its own once done or refused. */
const runRetry = (target: string, prefix: string) =>
  execFileSync(process.execPath, ['-e', RETRY_SCRIPT, target, prefix], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('makes a profile under the temp folder and removes it', () => {
  const p = makeSmokeProfile(PREFIX);
  made.push(p);
  expect(existsSync(p)).toBe(true);
  removeSmokeProfile(p, PREFIX);
  expect(existsSync(p)).toBe(false);
});

test('refuses a prefix that is not a smoke one', () => {
  expect(() => makeSmokeProfile('bw-')).toThrow();
});

test('never removes a folder of another prefix, or one deeper than the temp folder', () => {
  const other = dir('bw-other-');
  removeSmokeProfile(other, PREFIX);
  expect(existsSync(other)).toBe(true);
  const outer = dir('bw-outer-');
  const nested = join(outer, `${PREFIX}abc`);
  mkdirSync(nested);
  removeSmokeProfile(nested, PREFIX);
  expect(existsSync(nested)).toBe(true);
});

test('the detached cleanup checks the folder itself before deleting', () => {
  const other = dir('bw-other-');
  runRetry(other, PREFIX);
  expect(existsSync(other)).toBe(true);
  runRetry(other, 'bw-'); // a prefix the script itself refuses
  expect(existsSync(other)).toBe(true);
  const outer = dir('bw-outer-');
  const nested = join(outer, `${PREFIX}abc`);
  mkdirSync(nested);
  runRetry(nested, PREFIX);
  expect(existsSync(nested)).toBe(true);
  const own = dir(PREFIX);
  runRetry(own, PREFIX);
  expect(existsSync(own)).toBe(false);
});
