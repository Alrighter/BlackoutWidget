import { net } from 'electron';
import type { HttpFetch } from './http';

/** Chromium's network stack, so the system proxy and certificate store apply. No HTTP cache: every refresh asks the site. */
export const electronHttp: HttpFetch = (url, init) => net.fetch(url, { ...init, cache: 'no-store' });
