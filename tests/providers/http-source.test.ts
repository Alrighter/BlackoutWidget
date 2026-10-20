import { describe, expect, it, vi } from 'vitest';
import type { HttpFetch, HttpResponse } from '../../src/main/providers/http';
import { HttpSource, quietNote, sourceTexts } from '../../src/main/providers/http-source';
import { NetworkError, ProviderError } from '../../src/main/providers/types';
import { VOE_QUIET_NOTE } from '../../src/main/providers/voe';
import type { Logger } from '../../src/main/log';

const texts = sourceTexts('Тернопільобленерго');

const ok = (body: string): HttpResponse => ({
  ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const status = (code: number): HttpResponse => ({
  ok: false, status: code, text: async () => 'Замовник Петренко', arrayBuffer: async () => new ArrayBuffer(0),
});

function setup(fetch: HttpFetch, extra: Partial<ConstructorParameters<typeof HttpSource>[0]> = {}) {
  const log: Logger & { calls: unknown[][] } = {
    calls: [],
    info: vi.fn(), warn: vi.fn((...a: unknown[]) => { log.calls.push(a); }), error: vi.fn((...a: unknown[]) => { log.calls.push(a); }),
  };
  const src = new HttpSource({ fetch, isOnline: () => true, log, tag: 'ter', texts, ...extra });
  return { src, log };
}

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try { await p; } catch (e) { return e as ProviderError; }
  throw new Error('expected a rejection');
}

describe('texts', () => {
  it('sourceTexts spells the four request errors', () => {
    expect(texts).toEqual({
      offline: 'Немає з’єднання з сайтом Тернопільобленерго',
      noAnswer: 'Сайт Тернопільобленерго не відповідає',
      httpError: 'Сайт Тернопільобленерго повернув помилку',
      unreadable: 'Не вдалося прочитати графік Тернопільобленерго',
    });
  });

  it('quietNote matches the Volyn note byte for byte', () => {
    expect(quietNote('Волиньобленерго', 'опублікувало')).toBe(VOE_QUIET_NOTE);
    expect(quietNote('Х', 'опублікував')).toBe('Х не опублікував графік на сьогодні — зазвичай це означає, що відключень за графіком немає');
  });
});

describe('HttpSource', () => {
  it('serial runs operations one after the other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: string[] = [];
    const fetch: HttpFetch = async (url) => {
      started.push(url);
      if (url === 'a') await gate;
      return ok('x');
    };
    const { src } = setup(fetch);
    const first = src.serial('one', () => src.text('a'));
    const second = src.serial('two', () => src.text('b'));
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['a']);
    release();
    await Promise.all([first, second]);
    expect(started).toEqual(['a', 'b']);
  });

  it('a failed operation does not break the chain', async () => {
    const { src } = setup(async () => ok('fine'));
    await failure(src.serial('bad', async () => { throw new ProviderError('x'); }));
    await expect(src.serial('good', () => src.text('u'))).resolves.toBe('fine');
  });

  it('a rejected fetch is NetworkError offline and "no answer" online', async () => {
    const reject: HttpFetch = async () => { throw new Error('boom'); };
    const offline = await failure(setup(reject, { isOnline: () => false }).src.text('u'));
    expect(offline).toBeInstanceOf(NetworkError);
    expect(offline.message).toBe(texts.offline);
    const online = await failure(setup(reject).src.text('u'));
    expect(online).not.toBeInstanceOf(NetworkError);
    expect(online.message).toBe(texts.noAnswer);
  });

  it('a status of 500 is an HTTP error, 429 is "no answer"', async () => {
    expect((await failure(setup(async () => status(500)).src.text('u'))).message).toBe(texts.httpError);
    const busy = await failure(setup(async () => status(429)).src.text('u'));
    expect(busy.message).toBe(texts.noAnswer);
    expect(busy).not.toBeInstanceOf(NetworkError);
  });

  it('text, json and bytes read the body', async () => {
    const { src } = setup(async () => ok('{"a":1}'));
    expect(await src.text('u')).toBe('{"a":1}');
    expect(await src.json('u')).toEqual({ a: 1 });
    expect((await src.bytes('u')).byteLength).toBe(7);
  });

  it('a body that is not JSON is unreadable and leaks nothing', async () => {
    const { src, log } = setup(async () => ok('<html>Замовник Петренко</html>'));
    const err = await failure(src.serial('read', () => src.json('https://x/y')));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe(texts.unreadable);
    expect(JSON.stringify(err.cause)).not.toContain('Петренко');
    expect(JSON.stringify(log.calls)).not.toContain('Петренко');
    for (const call of log.calls) for (const arg of call) expect(String(arg)).not.toContain('Петренко');
  });

  it('a foreign error inside serial becomes unreadable and is logged by name', async () => {
    const { src, log } = setup(async () => ok(''));
    const err = await failure(src.serial('parse', async () => { throw new TypeError('Замовник Петренко'); }));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe(texts.unreadable);
    expect(JSON.stringify(err.cause)).not.toContain('Петренко');
    expect(log.error).toHaveBeenCalledWith('ter parse failed', err);
  });

  it('a ProviderError passes through serial unchanged', async () => {
    const { src } = setup(async () => ok(''));
    const mine = src.unreadable({ field: 'x' });
    expect(await failure(src.serial('op', async () => { throw mine; }))).toBe(mine);
  });

  it('minGapMs makes the second request wait out the rest of the gap', async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const { src } = setup(async () => ok('x'), {
      minGapMs: 1500, clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await src.text('a');
    expect(sleeps).toEqual([]);
    now += 400;
    await src.text('b');
    expect(sleeps).toEqual([1100]);
    now += 5000;
    await src.text('c');
    expect(sleeps).toEqual([1100]);
  });

  it('every fetch gets an abort signal and the default method is GET', async () => {
    const seen: Array<Parameters<HttpFetch>[1]> = [];
    const { src } = setup(async (_u, init) => { seen.push(init); return ok('x'); });
    await src.text('a');
    await src.bytes('b', { method: 'POST', body: 'q' });
    expect(seen[0].method).toBe('GET');
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[1].method).toBe('POST');
    expect(seen[1].signal).toBeInstanceOf(AbortSignal);
  });
});
