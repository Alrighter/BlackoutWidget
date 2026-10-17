export type WallpaperStyle = 'fill' | 'fit' | 'stretch' | 'tile' | 'center' | 'span';

/** Parses `reg query` output ("    Name    REG_SZ    Value" lines) into a name → value map. */
export function parseRegQuery(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S.*?)\s{2,}REG_\w+(?:\s{2,}(.*))?$/.exec(line);
    if (m) values[m[1]] = (m[2] ?? '').trim();
  }
  return values;
}

export function toWallpaperStyle(wallpaperStyle: string | undefined, tile: string | undefined): WallpaperStyle {
  switch (wallpaperStyle) {
    case '10': return 'fill';
    case '6': return 'fit';
    case '2': return 'stretch';
    case '22': return 'span';
    case '0': return tile === '1' ? 'tile' : 'center';
    default: return 'fill';
  }
}
