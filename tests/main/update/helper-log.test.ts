import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../../src/main/log';
import { drainHelperLog } from '../../../src/main/update/helper-log';

const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const file = () => join(mkdtempSync(join(tmpdir(), 'bw-hlog-')), 'update-helper.log');

test('each line becomes a warning in the app log, then the file is removed', () => {
  const f = file(); const log = logger();
  writeFileSync(f, 'mv: rename failed\n\nthe new version could not be moved in; the old one is back\n');
  drainHelperLog(f, log);
  expect(vi.mocked(log.warn).mock.calls).toEqual([
    ['update helper: mv: rename failed'],
    ['update helper: the new version could not be moved in; the old one is back'],
  ]);
  expect(existsSync(f)).toBe(false);
});

test('a missing file does nothing', () => {
  const log = logger();
  drainHelperLog(file(), log);
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
});

test('an unreadable path does not throw', () => {
  const log = logger();
  const dir = mkdtempSync(join(tmpdir(), 'bw-hlog-')); // a directory where the file should be
  expect(() => drainHelperLog(dir, log)).not.toThrow();
});
