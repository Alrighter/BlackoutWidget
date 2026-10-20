/** The slice of a fetch Response the plain-HTTP providers read. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A main-process fetch (Electron `net.fetch` in the app, a fixture router in tests). */
export type HttpFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponse>;
