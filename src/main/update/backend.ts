/**
 * A download that gets no data for this long fails (and a click starts it again). On mobile data a dead connection
 * usually stalls rather than resets, and neither Chromium nor electron-updater would end it soon.
 */
export const DOWNLOAD_STALL_MS = 60_000;

/** One platform's way of finding, fetching and installing a newer release. The controller decides when. */
export interface UpdateBackend {
  /** The newer version on the feed, or null. Never downloads. */
  check(): Promise<string | null>;
  /** False when this installation can't replace itself (macOS outside a writable folder). */
  canInstall(): boolean;
  /** The manual way: opens the release page of `version` in the browser. */
  openManual(version: string): void;
  /** Downloads (and on macOS verifies and unpacks) `version`; percent 0–100. Rejects on any failure. */
  download(version: string, onProgress: (percent: number) => void): Promise<void>;
  /** Quits the app and installs. Rejects if it could not start; then the app keeps running. */
  install(): Promise<void>;
}
