/**
 * The macOS swap helper: a /bin/sh script the app starts detached right before it quits. It waits for the app's
 * process to exit (the single-instance lock), moves the old bundle aside, moves the new one in and opens it. Any
 * failure puts the old bundle back and opens that. It writes only failures, to its log, which the app moves into its
 * own log on the next start (helper-log.ts).
 *
 * Arguments: the app's pid, its bundle, the new bundle (unpacked and checked), the log. Environment, for tests:
 * BW_OPEN (default `open`), BW_WAIT_S (seconds to wait for the app to quit, default 60).
 */
export const HELPER_SCRIPT = [
  '#!/bin/sh',
  'pid="$1"; old="$2"; new="$3"; log="$4"; wait_s="${BW_WAIT_S:-60}"; opener="${BW_OPEN:-open}"',
  'mkdir -p "$(dirname "$log")"',
  'i=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  i=$((i+1))',
  '  if [ "$i" -gt $((wait_s*5)) ]; then echo "the app did not quit" >>"$log"; exit 1; fi',
  '  sleep 0.2',
  'done',
  'backup="$old.old-$$"',
  'if mv "$old" "$backup" 2>>"$log"; then',
  '  if mv "$new" "$old" 2>>"$log"; then rm -rf "$backup"; "$opener" "$old"; exit 0; fi',
  '  if mv "$backup" "$old" 2>>"$log"; then',
  '    echo "the new version could not be moved in; the old one is back" >>"$log"',
  '  else',
  '    echo "the new version could not be moved in, nor the old one back: it is at $backup" >>"$log"; exit 1',
  '  fi',
  'else',
  '  echo "the old version could not be moved aside" >>"$log"',
  'fi',
  '"$opener" "$old"',
  'exit 1',
  '',
].join('\n');

export function helperArgs(o: { pid: number; bundle: string; staged: string; log: string }): string[] {
  return [String(o.pid), o.bundle, o.staged, o.log];
}
