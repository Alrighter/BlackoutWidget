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
  getWidgetState: () => ipcRenderer.invoke(IPC.widgetGetState),
  onWidgetState: cb => subscribe(IPC.widgetState, cb),
  onBackground: cb => subscribe(IPC.background, cb),
  listProviders: () => ipcRenderer.invoke(IPC.listProviders),
  listCities: providerId => ipcRenderer.invoke(IPC.listCities, providerId),
  listStreets: (providerId, city) => ipcRenderer.invoke(IPC.listStreets, providerId, city),
  listHouses: (providerId, city, street) => ipcRenderer.invoke(IPC.listHouses, providerId, city, street),
  houseLines: (providerId, city, street, house) => ipcRenderer.invoke(IPC.houseLines, providerId, city, street, house),
  previewLines: (providerId, city, street, house) => ipcRenderer.invoke(IPC.previewLines, providerId, city, street, house),
  addLocation: input => ipcRenderer.invoke(IPC.addLocation, input),
  editLocation: (id, input) => ipcRenderer.invoke(IPC.editLocation, id, input),
  renameLocation: (id, name) => ipcRenderer.invoke(IPC.renameLocation, id, name),
  deleteLocation: id => ipcRenderer.invoke(IPC.deleteLocation, id),
  setWidgetStyle: (id, s) => ipcRenderer.invoke(IPC.setWidgetStyle, id, s),
  setActualLocation: id => ipcRenderer.invoke(IPC.setActualLocation, id),
  setAutostart: on => ipcRenderer.invoke(IPC.setAutostart, on),
  refreshNow: (id?: string) => ipcRenderer.invoke(IPC.refreshNow, id),
  solveCaptcha: (providerId?: string) => ipcRenderer.invoke(IPC.solveCaptcha, providerId),
  onNavigate: cb => subscribe(IPC.navigate, cb),
  openMainWindow: view => ipcRenderer.send(IPC.openMainWindow, view),
  widgetContextMenu: () => ipcRenderer.send(IPC.widgetContextMenu),
  widgetDrag: (phase, x, y) => ipcRenderer.send(IPC.widgetDrag, phase, x, y),
  onMoveMode: cb => subscribe(IPC.widgetMoveMode, cb),
  endMoveMode: () => ipcRenderer.send(IPC.widgetMoveDone),
  ecoflowTest: i => ipcRenderer.invoke(IPC.ecoflowTest, i),
  ecoflowScan: () => ipcRenderer.invoke(IPC.ecoflowScan),
  ecoflowPreview: (i, sn) => ipcRenderer.invoke(IPC.ecoflowPreview, i, sn),
  ecoflowSave: (i, device) => ipcRenderer.invoke(IPC.ecoflowSave, i, device),
  actualDisconnect: () => ipcRenderer.invoke(IPC.actualDisconnect),
  openEcoflowHelp: () => ipcRenderer.send(IPC.openEcoflowHelp),
  openProviderSite: (providerId: string) => ipcRenderer.send(IPC.openProviderSite, providerId),
  getActualLive: () => ipcRenderer.invoke(IPC.getActualLive),
  onActualLive: cb => subscribe(IPC.actualLive, cb),
};

contextBridge.exposeInMainWorld('api', api);
