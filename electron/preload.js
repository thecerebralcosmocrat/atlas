const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // IPC bridge — filled in as we build each feature
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, cb) => ipcRenderer.on(channel, (_, ...args) => cb(...args)),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
});
