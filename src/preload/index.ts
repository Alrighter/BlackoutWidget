import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RendererApi } from '../shared/ipc';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: cb => subscribe(IPC.state, cb),
  onBackground: cb => subscribe(IPC.background, cb),
  listProviders: () => ipcRenderer.invoke(IPC.listProviders),
  listCities: providerId => ipcRenderer.invoke(IPC.listCities, providerId),
  listStreets: (providerId, city) => ipcRenderer.invoke(IPC.listStreets, providerId, city),
  listHouses: (providerId, city, street) => ipcRenderer.invoke(IPC.listHouses, providerId, city, street),
  previewLines: (providerId, city, street, house) => ipcRenderer.invoke(IPC.previewLines, providerId, city, street, house),
  saveAddress: a => ipcRenderer.invoke(IPC.saveAddress, a),
  setWidgetStyle: s => ipcRenderer.invoke(IPC.setWidgetStyle, s),
  setAutostart: on => ipcRenderer.invoke(IPC.setAutostart, on),
  refreshNow: () => ipcRenderer.invoke(IPC.refreshNow),
  solveCaptcha: () => ipcRenderer.invoke(IPC.solveCaptcha),
  onNavigate: cb => subscribe(IPC.navigate, cb),
  openMainWindow: view => ipcRenderer.send(IPC.openMainWindow, view),
  widgetContextMenu: () => ipcRenderer.send(IPC.widgetContextMenu),
  widgetDrag: (phase, x, y) => ipcRenderer.send(IPC.widgetDrag, phase, x, y),
  onMoveMode: cb => subscribe(IPC.widgetMoveMode, cb),
  endMoveMode: () => ipcRenderer.send(IPC.widgetMoveDone),
  ecoflowTest: i => ipcRenderer.invoke(IPC.ecoflowTest, i),
  ecoflowPreview: (i, sn) => ipcRenderer.invoke(IPC.ecoflowPreview, i, sn),
  ecoflowSave: (i, device) => ipcRenderer.invoke(IPC.ecoflowSave, i, device),
  actualDisconnect: () => ipcRenderer.invoke(IPC.actualDisconnect),
  openEcoflowHelp: () => ipcRenderer.send(IPC.openEcoflowHelp),
  openDtekSite: () => ipcRenderer.send(IPC.openDtekSite),
  getActualLive: () => ipcRenderer.invoke(IPC.getActualLive),
  onActualLive: cb => subscribe(IPC.actualLive, cb),
};

contextBridge.exposeInMainWorld('api', api);
