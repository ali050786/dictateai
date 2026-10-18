import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dictateAI', {
  sendAudioChunk: (data: ArrayBuffer) => {
    ipcRenderer.send('audio:chunk', data);
  },
  getState: () => ipcRenderer.invoke('dictation:getState'),
  onStateChange: (callback: (state: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: string) =>
      callback(state);
    ipcRenderer.on('dictation:state', handler);
    return () => {
      ipcRenderer.removeListener('dictation:state', handler);
    };
  },
  onPreview: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    ipcRenderer.on('dictation:preview', handler);
    return () => {
      ipcRenderer.removeListener('dictation:preview', handler);
    };
  },
});
