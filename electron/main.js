const { app, BrowserWindow } = require("electron");
const path = require("path");

const isDev = process.env.NODE_ENV === "development";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minHeight: 600,
    minWidth: 1000,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "rgba(0,0,0,0)",
      symbolColor: "#ffffff",
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();

  if (isDev) {
    win.loadURL("http://localhost:5173");
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../dist/renderer/index.html"));
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
