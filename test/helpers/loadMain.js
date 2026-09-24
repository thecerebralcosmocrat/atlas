const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { makeTempDir } = require("./tempDirs");

// require.resolve rather than path.resolve: these have to match the keys
// require.cache actually uses, or clearing the entry is a silent no-op and the
// next load returns the cached module without registering any handlers.
const ELECTRON_ID = require.resolve("electron");
const MAIN_PATH = require.resolve("../../electron/main");
const INDEXER_PATH = require.resolve(
  "../../electron/indexer/IndexerService",
);

// Loads electron/main.js with a stubbed `electron` module so the IPC wiring can
// be exercised without a real Electron app/BrowserWindow. Returns the captured
// handlers, the events pushed to the fake renderer, and the window listeners the
// sync poller registered (a test can call `focus` to stand in for the user
// returning to the window rather than waiting on the five-minute timer).
//
// Pass an `indexerClass` to replace the real IndexerService, used to make
// indexing fail or block on demand.
async function loadMain({ userData, indexerClass } = {}) {
  const handlers = new Map();
  const sentEvents = [];
  const windowListeners = new Map();

  const fakeWindow = {
    removeMenu() {},
    loadURL() {},
    loadFile() {},
    on: (event, listener) => windowListeners.set(event, listener),
    webContents: {
      send: (channel, payload) => sentEvents.push({ channel, payload }),
    },
  };

  function FakeBrowserWindow() {
    return fakeWindow;
  }
  FakeBrowserWindow.fromWebContents = () => fakeWindow;

  const fakeElectron = {
    app: {
      getPath: () => userData,
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  };

  const previousElectron = require.cache[ELECTRON_ID];
  require.cache[ELECTRON_ID] = {
    id: ELECTRON_ID,
    filename: ELECTRON_ID,
    loaded: true,
    exports: fakeElectron,
  };
  const previousMain = require.cache[MAIN_PATH];
  const previousIndexer = require.cache[INDEXER_PATH];

  if (indexerClass) {
    require.cache[INDEXER_PATH] = {
      id: INDEXER_PATH,
      filename: INDEXER_PATH,
      loaded: true,
      exports: { IndexerService: indexerClass },
    };
  }

  try {
    require(MAIN_PATH);
  } finally {
    if (previousElectron) require.cache[ELECTRON_ID] = previousElectron;
    else delete require.cache[ELECTRON_ID];

    if (previousIndexer) require.cache[INDEXER_PATH] = previousIndexer;
    else delete require.cache[INDEXER_PATH];

    if (previousMain) require.cache[MAIN_PATH] = previousMain;
    else delete require.cache[MAIN_PATH];
  }

  // app.whenReady().then(...) registers handlers on a later microtask/tick.
  const deadline = Date.now() + 5000;
  while (!handlers.has("repositories:add") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return { handlers, sentEvents, windowListeners };
}

// A committed git working tree that can be cloned from a file:// URL, standing
// in for a repository on a remote host.
function makeGitFixtureRepo(files = null) {
  const root = makeTempDir("atlas-gitfixture-");
  const entries = files ?? {
    "index.js": "const a = 1;\n",
    "src/app.py": "print('hi')\n",
  };

  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(root, relativePath);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");

  return root;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "ignore" });
}

// Waits until `predicate` returns a truthy value, so tests can observe the
// background work the app kicks off without sleeping a fixed amount.
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = await predicate();

  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await predicate();
  }

  return value;
}

module.exports = { loadMain, makeGitFixtureRepo, git, waitFor };
