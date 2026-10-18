import { contextBridge, ipcRenderer, shell } from 'electron';

contextBridge.exposeInMainWorld('hub', {
  dictionary: {
    list: () => ipcRenderer.invoke('dictionary:list'),
    add: (from: string, to: string) => ipcRenderer.invoke('dictionary:add', from, to),
    remove: (from: string) => ipcRenderer.invoke('dictionary:remove', from),
  },
  config: {
    hasApiKey: () => ipcRenderer.invoke('config:hasApiKey'),
    setApiKey: (key: string) => ipcRenderer.invoke('config:setApiKey', key),
    hasAccessibility: () => ipcRenderer.invoke('config:hasAccessibility'),
    getLanguage: () => ipcRenderer.invoke('config:getLanguage'),
    setLanguage: (lang: string) => ipcRenderer.invoke('config:setLanguage', lang),
    sttStatus: () => ipcRenderer.invoke('config:sttStatus'),
    getLlmEnabled: () => ipcRenderer.invoke('config:getLlmEnabled'),
    setLlmEnabled: (enabled: boolean) => ipcRenderer.invoke('config:setLlmEnabled', enabled),
    getShortcut: () => ipcRenderer.invoke('config:getShortcut'),
    setShortcut: (shortcut: Record<string, unknown>) => ipcRenderer.invoke('config:setShortcut', shortcut),
    getAudioDevice: () => ipcRenderer.invoke('config:getAudioDevice'),
    setAudioDevice: (deviceId: string) => ipcRenderer.invoke('config:setAudioDevice', deviceId),
    getPillPosition: () => ipcRenderer.invoke('config:getPillPosition'),
    setPillPosition: (position: string) => ipcRenderer.invoke('config:setPillPosition', position),
    getMuteWhileSpeaking: () => ipcRenderer.invoke('config:getMuteWhileSpeaking'),
    setMuteWhileSpeaking: (enabled: boolean) => ipcRenderer.invoke('config:setMuteWhileSpeaking', enabled),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
  },
  onDictationLog: (callback: (entry: { text: string; app: string; time: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: { text: string; app: string; time: string }) =>
      callback(entry);
    ipcRenderer.on('dictation:log', handler);
    return () => ipcRenderer.removeListener('dictation:log', handler);
  },
  onSttRestarting: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('stt:restarting', handler);
    return () => ipcRenderer.removeListener('stt:restarting', handler);
  },
  onSttStatusChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('stt:status-changed', handler);
    return () => ipcRenderer.removeListener('stt:status-changed', handler);
  },
  openExternal: (url: string) => shell.openExternal(url),
});
