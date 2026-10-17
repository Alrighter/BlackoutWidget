import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRegQuery, toWallpaperStyle, type WallpaperStyle } from './wallpaper-parse';

const exists = (p: string) => access(p).then(() => true, () => false);

function regQuery(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop'], { windowsHide: true, timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The current desktop wallpaper (one for all monitors) and how it is laid out, or null when there is none. */
export async function readWallpaper(): Promise<{ path: string; style: WallpaperStyle } | null> {
  const values = parseRegQuery(await regQuery());
  const style = toWallpaperStyle(values.WallpaperStyle, values.TileWallpaper);
  const configured = values.WallPaper;
  if (configured && await exists(configured)) return { path: configured, style };
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const transcoded = join(appData, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  return await exists(transcoded) ? { path: transcoded, style } : null;
}
