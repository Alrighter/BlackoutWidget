import { parseRegQuery, toWallpaperStyle } from '../../src/main/widget/wallpaper-parse';

const out = `\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    WallPaper    REG_SZ    C:\\Users\\me\\Pictures\\wall.jpg\r\n    WallpaperStyle    REG_SZ    10\r\n    TileWallpaper    REG_SZ    0\r\n`;
test('parseRegQuery', () => expect(parseRegQuery(out)).toMatchObject({ WallPaper: 'C:\\Users\\me\\Pictures\\wall.jpg', WallpaperStyle: '10', TileWallpaper: '0' }));
test('toWallpaperStyle', () => {
  expect(toWallpaperStyle('10', '0')).toBe('fill'); expect(toWallpaperStyle('6', '0')).toBe('fit'); expect(toWallpaperStyle('2', '0')).toBe('stretch');
  expect(toWallpaperStyle('22', '0')).toBe('span'); expect(toWallpaperStyle('0', '1')).toBe('tile'); expect(toWallpaperStyle('0', '0')).toBe('center');
  expect(toWallpaperStyle(undefined, undefined)).toBe('fill');
});
