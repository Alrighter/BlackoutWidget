import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLogger } from '../../src/main/file-logger';
import { describeError, formatLogLine } from '../../src/main/log';

test('formatLogLine: ISO time, level, message, JSON data', () => {
  const line = formatLogLine(new Date('2026-10-17T08:00:00Z'), 'INFO', 'raw entry', { house: '40', type: 'Аварійне' });
  expect(line).toBe('2026-10-17T08:00:00.000Z INFO raw entry {"house":"40","type":"Аварійне"}\n');
});

test('describeError includes the cause chain', () => {
  const err = new Error('outer', { cause: new TypeError('inner', { cause: { code: -106 } }) });
  expect(describeError(err)).toBe('Error: outer\n  caused by: TypeError: inner\n  caused by: {"code":-106}');
});

test('FileLogger appends lines and rotates to app.log.1 past maxBytes, keeping one previous file', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bw-log-')), 'logs');
  const log = new FileLogger(dir, { maxBytes: 300, mirrorToConsole: false });
  for (let i = 0; i < 20; i++) log.info(`line ${i}`, { pad: 'x'.repeat(40) });
  expect(readdirSync(dir).sort()).toEqual(['app.log', 'app.log.1']);
  expect(statSync(join(dir, 'app.log')).size).toBeLessThanOrEqual(300);
  expect(statSync(join(dir, 'app.log.1')).size).toBeLessThanOrEqual(300);
  expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('INFO line 19 ');
  // A new logger over an existing file continues counting from its current size.
  const again = new FileLogger(dir, { maxBytes: 300, mirrorToConsole: false });
  again.error('boom', new Error('bad', { cause: new Error('root') }));
  const text = readFileSync(join(dir, 'app.log'), 'utf8') + readFileSync(join(dir, 'app.log.1'), 'utf8');
  expect(text).toContain('ERROR boom Error: bad');
  expect(text).toContain('caused by: Error: root');
});

test('FileLogger never throws, even when the directory cannot be created', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bw-log-')), 'not-a-dir');
  writeFileSync(file, 'x');
  const log = new FileLogger(join(file, 'logs'), { mirrorToConsole: false });
  expect(() => log.warn('still fine')).not.toThrow();
});
