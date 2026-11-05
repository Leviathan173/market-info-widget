'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const PUSH_CHANNELS = ['push:quotes', 'push:flash', 'push:status', 'settings:changed', 'window:resized', 'ui:close-sheet', 'ui:mini-measure'];

contextBridge.exposeInMainWorld('market', {
  init: () => ipcRenderer.invoke('app:init'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  action: (name) => ipcRenderer.invoke('window:action', name),
  miniWidth: (width) => ipcRenderer.invoke('window:mini-width', width),
  openFlash: (id) => ipcRenderer.invoke('flash:open', id),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  on: (channel, cb) => {
    if (!PUSH_CHANNELS.includes(channel)) return () => {};
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});