import type { Logger } from '../log';
import type { HttpFetch, HttpResponse } from './http';
import { NetworkError, ProviderError } from './types';

export interface SourceTexts { offline: string; noAnswer: string; httpError: string; unreadable: string }

/** The four request errors every plain-HTTPS source shows, spelled with the operator's name. */
export function sourceTexts(name: string): SourceTexts {
  return {
    offline: `Немає з’єднання з сайтом ${name}`,
    noAnswer: `Сайт ${name} не відповідає`,
    httpError: `Сайт ${name} повернув помилку`,
    unreadable: `Не вдалося прочитати графік ${name}`,
  };
}

/** The note for a day the operator published nothing for; `verb` agrees with the operator's gender. */
export function quietNote(name: string, verb: 'опублікувало' | 'опублікував'): string {
  return `${name} не ${verb} графік на сьогодні — зазвичай це означає, що відключень за графіком немає`;
}

export type SourceInit = Omit<Parameters<HttpFetch>[1], 'signal'>;

export interface HttpSourceOptions {
  fetch: HttpFetch;
  isOnline: () => boolean;
  log: Logger;
  tag: string;
  texts: SourceTexts;
  timeoutMs?: number;
  /** The least time between the starts of two requests. */
  minGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/** Only the kind of a failure goes into a cause: an error's message may quote the response body. */
const kind = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** An error as it may go to the log: a ProviderError (message and cause are ours) as it is, anything else by its kind only. */
export const loggable = (e: unknown): unknown => (e instanceof ProviderError ? e : { error: kind(e) });

/** The request plumbing shared by the plain-HTTPS providers: one request at a time, a timeout, and the four error texts. */
export class HttpSource {
  private readonly timeoutMs: number;
  private readonly minGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private lastStart: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: HttpSourceOptions) {
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.minGapMs = o.minGapMs ?? 0;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = o.clock ?? Date.now;
  }

  /** One operation at a time; a failure does not break the chain. Callers only ever see ProviderError. Never nest. */
  serial<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.guard(op, fn));
    this.tail = run.catch(() => {});
    return run;
  }

  text(url: string, init: SourceInit = { method: 'GET' }): Promise<string> {
    return this.call(url, init, (r) => r.text());
  }

  /** A body that is not JSON is unreadable. */
  async json(url: string, init: SourceInit = { method: 'GET' }): Promise<unknown> {
    const body = await this.text(url, init);
    try {
      return JSON.parse(body) as unknown;
    } catch (e) {
      throw this.unreadable({ url, error: kind(e) });
    }
  }

  bytes(url: string, init: SourceInit = { method: 'GET' }): Promise<ArrayBuffer> {
    return this.call(url, init, (r) => r.arrayBuffer());
  }

  /** The «could not read» error. The cause may carry a url, status, field name or short reason, never body text. */
  unreadable(cause?: Record<string, unknown>): ProviderError {
    return new ProviderError(this.o.texts.unreadable, cause === undefined ? undefined : { cause });
  }

  // Callers only ever see ProviderError (incl. NetworkError); anything else is a response we could not read.
  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof ProviderError ? e : this.unreadable({ error: kind(e) });
      this.o.log.error(`${this.o.tag} ${op} failed`, err);
      throw err;
    }
  }

  /** One request with a timeout. No answer is NetworkError when offline, else «не відповідає»; a bad status is «повернув помилку». */
  private async call<T>(url: string, init: SourceInit, read: (r: HttpResponse) => Promise<T>): Promise<T> {
    await this.pace();
    let res: HttpResponse;
    try {
      res = await this.o.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw this.noAnswer(url, e);
    }
    // Too many requests is the source asking us to back off, not a broken page.
    if (res.status === 429) throw new ProviderError(this.o.texts.noAnswer, { cause: { url, status: res.status } });
    if (!res.ok) throw new ProviderError(this.o.texts.httpError, { cause: { url, status: res.status } });
    try {
      return await read(res);
    } catch (e) {
      throw this.noAnswer(url, e);
    }
  }

  private async pace(): Promise<void> {
    if (this.minGapMs > 0 && this.lastStart !== undefined) {
      const wait = this.minGapMs - (this.clock() - this.lastStart);
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart = this.clock();
  }

  private noAnswer(url: string, e: unknown): ProviderError {
    const cause = { url, error: kind(e) };
    if (!this.o.isOnline()) return new NetworkError(this.o.texts.offline, { cause });
    return new ProviderError(this.o.texts.noAnswer, { cause });
  }
}
