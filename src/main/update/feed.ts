/**
 * Where updates come from. Normal builds read the latest full release of the public repo (pre-releases and drafts
 * never count). A build made with env BW_UPDATE_FEED reads that URL instead, as a generic feed: the hidden test
 * pre-release that proves a new updater before it ships. There is no UI or settings key for it.
 */
declare const __UPDATE_FEED__: string;

export const UPDATE_FEED: string = typeof __UPDATE_FEED__ === 'undefined' ? '' : __UPDATE_FEED__;

const OWNER = 'Alrighter';
const REPO = 'BlackoutWidget';
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;

/**
 * The feed a build bakes in, from env BW_UPDATE_FEED (electron.vite.config.ts). Only a test version (one with a
 * prerelease part, e.g. 1.0.1-test.1) may take one: a release built in a shell where the variable was left set would
 * otherwise read the test feed for good, and could never update itself. Throws, so that build fails.
 */
export function buildFeed(env: string | undefined, version: string): string {
  const feed = (env ?? '').trim().replace(/\/+$/, '');
  if (!feed) return '';
  if (!version.includes('-')) {
    throw new Error(`BW_UPDATE_FEED is set, but ${version} is a release version: a release must read the GitHub releases. `
      + 'Unset it (PowerShell: Remove-Item Env:BW_UPDATE_FEED) or build a test version (x.y.z-test.n).');
  }
  if (!/^https:\/\/[^/\s]+\/\S*$/.test(`${feed}/`)) throw new Error(`BW_UPDATE_FEED must be an https URL, not ${feed}`);
  return feed;
}

/** What setFeedURL takes: a generic feed (the test override) or the GitHub releases. */
export type FeedConfig = { provider: 'generic'; url: string } | { provider: 'github'; owner: string; repo: string };

export function feedConfig(feed: string): FeedConfig {
  return feed ? { provider: 'generic', url: feed } : { provider: 'github', owner: OWNER, repo: REPO };
}

/** The folder a release's files download from; the names in its latest*.yml are relative to it. */
export function downloadBase(feed: string, version: string): string {
  return feed ? `${feed}/` : `${RELEASES}/download/v${version}/`;
}

export function releasePage(version: string): string {
  return `${RELEASES}/tag/v${version}`;
}
