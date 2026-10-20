import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('welcome', {
  status: () => ipcRenderer.invoke('welcome:status'),
  openAccessibility: () => ipcRenderer.invoke('welcome:openAccessibility'),
  allowMicrophone: () => ipcRenderer.invoke('welcome:allowMicrophone'),
  retrySpeech: () => ipcRenderer.invoke('welcome:retrySpeech'),
  cleanupPlan: (lang: string) => ipcRenderer.invoke('config:cleanupPlan', lang),
  finish: (lang: string, enableCleanup: boolean) => ipcRenderer.invoke('welcome:finish', lang, enableCleanup),
  close: () => ipcRenderer.invoke('welcome:close'),
  onDictationLog: (callback: (entry: { text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: { text: string }) => callback(entry);
    ipcRenderer.on('dictation:log', handler);
    return () => ipcRenderer.removeListener('dictation:log', handler);
  },
  onStatusChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('stt:status-changed', handler);
    return () => ipcRenderer.removeListener('stt:status-changed', handler);
  },
});
