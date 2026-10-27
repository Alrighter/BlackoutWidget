import { readFileSync, rmSync } from 'node:fs';
import type { Logger } from '../log';

/**
 * The macOS swap helper runs after the app has quit, so it writes its failures to a file of its own. The next start
 * moves each line into the app log and removes the file. Never throws.
 */
export function drainHelperLog(file: string, log: Logger): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // no helper ran, or it had nothing to say
  }
  for (const line of text.split('\n')) {
    if (line.trim()) log.warn(`update helper: ${line.trimEnd()}`);
  }
  try {
    rmSync(file, { force: true });
  } catch (err) {
    log.warn('update helper: its log could not be removed', err);
  }
}
