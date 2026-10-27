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
