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
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    create: (profile) => ipcRenderer.invoke("profiles:create", profile),
    update: (profileId, patch) =>
      ipcRenderer.invoke("profiles:update", { profileId, patch }),
    switch: (profileId) => ipcRenderer.invoke("profiles:switch", profileId),
    remove: (profileId) => ipcRenderer.invoke("profiles:remove", profileId),
    onChanged: (callback) => {
      const subscription = () => callback();
      ipcRenderer.on("profiles:changed", subscription);
      return () => {
        ipcRenderer.removeListener("profiles:changed", subscription);
      };
    },
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
    // `onText` receives the answer so far while the model is still writing it.
    // The resolved value is always the full final answer.
    ask: async (repositoryId, question, onText) => {
      if (typeof onText !== "function") {
        return ipcRenderer.invoke("repositories:ask", { repositoryId, question });
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const subscription = (event, value) => {
        if (value?.requestId === requestId) onText(value.text);
      };

      ipcRenderer.on("repositories:ask-text", subscription);

      try {
        return await ipcRenderer.invoke("repositories:ask", {
          repositoryId,
          question,
          requestId,
        });
      } finally {
        ipcRenderer.removeListener("repositories:ask-text", subscription);
      }
    },
    onIndexProgress: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("index-progress", subscription);
      return () => {
        ipcRenderer.removeListener("index-progress", subscription);
      };
    },
    onAddProgress: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("add-progress", subscription);
      return () => {
        ipcRenderer.removeListener("add-progress", subscription);
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
