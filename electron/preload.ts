import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Bridge, AudioApp, Settings, Languages, ServiceUpdate } from '../src/shared';
const bridge: Bridge = {
  getState: () => ipcRenderer.invoke('state:get'),
  listApps: () => ipcRenderer.invoke('apps:list'),
  start: (app: AudioApp) => ipcRenderer.invoke('capture:start', app),
  stop: () => ipcRenderer.invoke('capture:stop'),
  checkDevice: () => ipcRenderer.invoke('config:check'),
  openConfig: () => ipcRenderer.invoke('config:open'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetPosition: () => ipcRenderer.invoke('overlay:reset'),
  openModels: () => ipcRenderer.invoke('models:open'),
  downloadModel: () => ipcRenderer.invoke('models:download'),
  saveLanguages: (value: Languages) => ipcRenderer.invoke('config:languages', value),
  saveService: (value: ServiceUpdate) => ipcRenderer.invoke('config:service', value),
  overlayRegions: regions => ipcRenderer.invoke('overlay:regions', regions),
  dragOverlay: phase => ipcRenderer.invoke('overlay:drag', phase),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
};
contextBridge.exposeInMainWorld('kotoba', bridge);
