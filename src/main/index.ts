import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300 });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL + '/app.html');
  } else {
    void win.loadFile(join(__dirname, '../renderer/app.html'));
  }
});

app.on('window-all-closed', () => app.quit());
