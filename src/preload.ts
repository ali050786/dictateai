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
  getAudioDevice: () => ipcRenderer.invoke('config:getAudioDevice'),
  onAudioDeviceChanged: (callback: (deviceId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, deviceId: string) =>
      callback(deviceId);
    ipcRenderer.on('config:audioDeviceChanged', handler);
    return () => {
      ipcRenderer.removeListener('config:audioDeviceChanged', handler);
    };
  },
  onHandsfree: (callback: (active: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, active: boolean) =>
      callback(active);
    ipcRenderer.on('dictation:handsfree', handler);
    return () => {
      ipcRenderer.removeListener('dictation:handsfree', handler);
    };
  },
  onCue: (callback: (cue: 'start' | 'stop') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cue: 'start' | 'stop') =>
      callback(cue);
    ipcRenderer.on('dictation:cue', handler);
    return () => {
      ipcRenderer.removeListener('dictation:cue', handler);
    };
  },
  stopRecording: () => ipcRenderer.send('overlay:stopRecording'),
  setClickable: (clickable: boolean) => ipcRenderer.send('overlay:setClickable', clickable),
});
