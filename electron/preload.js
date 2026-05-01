const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  repositories: {
    list: () => ipcRenderer.invoke("repositories:list"),
    add: (repositoryUrl) =>
      ipcRenderer.invoke("repositories:add", repositoryUrl),
    inspect: (repositoryId) =>
      ipcRenderer.invoke("repositories:inspect", repositoryId),
    ask: (repositoryId, question) =>
      ipcRenderer.invoke("repositories:ask", { repositoryId, question }),
  },
});
