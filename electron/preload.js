const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
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
