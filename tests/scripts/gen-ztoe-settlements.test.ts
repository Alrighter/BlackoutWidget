// The Zhytomyr generator's choice between the live site and the saved capture (M5): only a site it cannot reach falls
// back. The site is faked with its saved windows-1251 pages. Importing the script neither fetches nor writes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Row { id: number; name: string; remId: number; rem: string }
interface Answer { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }
interface Gen {
  settlementRows(deps: {
    fetch: (url: string, init: { method?: string; body?: string }) => Promise<Answer>;
    sleep: (ms: number) => Promise<void>;
    fallback: () => { rows: Row[] };
  }): Promise<{ rows: Row[]; source: string }>;
}

const SCRIPT = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'gen-ztoe-settlements.mjs')).href;
const load = async (): Promise<Gen> => (await import(/* @vite-ignore */ SCRIPT)) as Gen;

const DIR = join(__dirname, '..', 'fixtures', 'ztoe');
/** The 20.10 GET: the rem_id select of 19 РЕМ. */
const REM_PAGE = readFileSync(join(DIR, 'unhooking-search-2026-10-20-1728-live-cp1251.html'));
/** A POST of РЕМ 5: its naspunkt_id select of 78 settlements. */
const SETTLEMENT_PAGE = readFileSync(join(DIR, 'post-rem5-ns16205-cp1251.html'));
/** The GET without its fifth РЕМ: latin1 maps each byte to itself, so the windows-1251 bytes around it stay. */
const EIGHTEEN_REMS = Buffer.from(REM_PAGE.toString('latin1').replace(/<option\s+value="5"[^>]*>[^<]*<\/option>/, ''), 'latin1');

const page = (b: Buffer): Answer => ({
  ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
});
const failStatus = (status: number): Answer => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) });
/** A 200 whose body never arrives: the connection drops while it is read. */
const droppedBody = (): Answer => ({ ok: true, status: 200, arrayBuffer: async () => { throw new TypeError('terminated'); } });
const SAVED: Row = { id: 1, name: 'с. Збережене', remId: 1, rem: 'Збережений' };

/** The generator over a fake site: `get` answers the GET, `post` each РЕМ's POST. */
async function run(get: () => Answer | Error, post: (remId: string) => Answer | Error = () => page(SETTLEMENT_PAGE)) {
  const fallback = vi.fn(() => ({ rows: [SAVED] }));
  const sleep = vi.fn(async () => {});
  const fetch = vi.fn(async (_url: string, init: { body?: string }) => {
    const r = init.body === undefined ? get() : post(new URLSearchParams(init.body).get('rem_id') ?? '');
    if (r instanceof Error) throw r;
    return r;
  });
  const result = (await load()).settlementRows({ fetch, sleep, fallback });
  return { result, fallback, sleep, fetch };
}

describe('gen-ztoe-settlements: live, or the saved capture only when the site is unreachable (M5)', () => {
  it('reads every РЕМ live, one second apart', async () => {
    const { result, fallback, sleep, fetch } = await run(() => page(REM_PAGE));
    const { rows, source } = await result;
    expect(source).toBe('live');
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(sleep).toHaveBeenCalledTimes(19);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(new Set(rows.map((r) => r.remId)).size).toBe(19);
    expect(rows).toHaveLength(19 * 78);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a network error or an HTTP error status, on the GET or a POST, falls back to the capture', async () => {
    for (const [get, post, reason] of [
      [() => new TypeError('fetch failed'), undefined, 'fetch failed'],
      [() => failStatus(503), undefined, '503'],
      [() => page(REM_PAGE), (rem: string) => (rem === '7' ? new TypeError('fetch failed') : page(SETTLEMENT_PAGE)), 'fetch failed'],
      [() => page(REM_PAGE), (rem: string) => (rem === '7' ? failStatus(502) : page(SETTLEMENT_PAGE)), '502'],
      [() => droppedBody(), undefined, 'terminated'],
      [() => page(REM_PAGE), (rem: string) => (rem === '7' ? droppedBody() : page(SETTLEMENT_PAGE)), 'terminated'],
    ] as const) {
      const { result, fallback } = await run(get, post);
      const { rows, source } = await result;
      expect(rows).toEqual([SAVED]);
      expect(source).toMatch(/^fallback \(site unreachable: /);
      expect(source).toContain(reason);
      expect(fallback).toHaveBeenCalledTimes(1);
    }
  });

  it('an answer of another shape or count stops the run with its own reason, never the capture', async () => {
    for (const [get, post, reason] of [
      [() => page(Buffer.from('<html>maintenance</html>')), undefined, 'no usable select rem_id'],
      [() => page(EIGHTEEN_REMS), undefined, 'expected 19 REMs, got 18'],
      // The GET page again: its naspunkt_id select is disabled.
      [() => page(REM_PAGE), () => page(REM_PAGE), 'no usable select naspunkt_id'],
    ] as const) {
      const { result, fallback } = await run(get, post);
      await expect(result).rejects.toThrow(reason);
      expect(fallback).not.toHaveBeenCalled();
    }
  });
});
