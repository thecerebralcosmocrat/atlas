const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    testConnection: () => ipcRenderer.invoke("settings:test-connection"),
    storageInfo: () => ipcRenderer.invoke("settings:storage-info"),
    openStorageFolder: () => ipcRenderer.invoke("settings:open-storage"),
    onChanged: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("settings:changed", subscription);
      return () => {
        ipcRenderer.removeListener("settings:changed", subscription);
      };
    },
  },
  graph: {
    get: (repositoryId) =>
      ipcRenderer.invoke("get-graph", { repoId: repositoryId }),
    startHere: (repositoryId) =>
      ipcRenderer.invoke("get-start-here", { repoId: repositoryId }),
    impact: (repositoryId, filePath) =>
      ipcRenderer.invoke("get-impact", { repoId: repositoryId, path: filePath }),
    ownership: (repositoryId, filePath) =>
      ipcRenderer.invoke("get-ownership", { repoId: repositoryId, path: filePath }),
  },
  repositories: {
    list: () => ipcRenderer.invoke("repositories:list"),
    add: (repositoryUrl) =>
      ipcRenderer.invoke("repositories:add", repositoryUrl),
    inspect: (repositoryId) =>
      ipcRenderer.invoke("repositories:inspect", repositoryId),
    remove: (repositoryId) =>
      ipcRenderer.invoke("repositories:remove", repositoryId),
    sync: (repositoryId) =>
      ipcRenderer.invoke("repositories:sync", repositoryId),
    discardChanges: (repositoryId) =>
      ipcRenderer.invoke("repositories:discard-changes", repositoryId),
    ask: (repositoryId, question) =>
      ipcRenderer.invoke("repositories:ask", { repositoryId, question }),
    onIndexProgress: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("index-progress", subscription);
      return () => {
        ipcRenderer.removeListener("index-progress", subscription);
      };
    },
    onChanged: (callback) => {
      const subscription = () => callback();
      ipcRenderer.on("repositories:changed", subscription);
      return () => {
        ipcRenderer.removeListener("repositories:changed", subscription);
      };
    },
  },
});
