import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dictateAI', {
  sendAudioChunk: (session: number, data: ArrayBuffer, final: boolean) => {
    ipcRenderer.send('audio:chunk', session, data, final);
  },
  onCapture: (callback: (command: 'start' | 'flush', session: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: 'start' | 'flush', session: number) =>
      callback(command, session);
    ipcRenderer.on('audio:capture', handler);
    return () => {
      ipcRenderer.removeListener('audio:capture', handler);
    };
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
  // The pill's place on screen, so the orb sits against that edge.
  onPosition: (callback: (position: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, position: string) =>
      callback(position);
    ipcRenderer.on('overlay:position', handler);
    return () => {
      ipcRenderer.removeListener('overlay:position', handler);
    };
  },
});
