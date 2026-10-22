import type { PinGuardFs } from '../../src/main/widget/pin-guard';

/** In-memory stand-in for the pin guard's fs subset: records writes and removals in order. */
export function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const ops: string[] = [];
  const fs: PinGuardFs = {
    existsSync: p => files.has(p),
    readFileSync: p => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
    writeFileSync: (p, data) => { ops.push(`write ${p} ${data}`); files.set(p, data); },
    rmSync: p => { ops.push(`rm ${p}`); files.delete(p); },
  };
  return { fs, files, ops };
}
