const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { initializeDatabase } = require("../electron/db/schema");

// Loads electron/main.js with a stubbed `electron` module so the IPC wiring can
// be exercised without a real Electron app/BrowserWindow. Returns the captured
// handlers plus the fake window that stands in for the renderer.
async function loadMain({ userData }) {
  const handlers = new Map();
  const sentEvents = [];

  const fakeWindow = {
    removeMenu() {},
    loadURL() {},
    loadFile() {},
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

  const electronId = require.resolve("electron");
  const previousElectron = require.cache[electronId];
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: fakeElectron,
  };
  const mainId = require.resolve("../electron/main");
  const previousMain = require.cache[mainId];

  try {
    require(mainId);
  } finally {
    if (previousElectron) require.cache[electronId] = previousElectron;
    else delete require.cache[electronId];

    if (previousMain) require.cache[mainId] = previousMain;
    else delete require.cache[mainId];
  }

  // app.whenReady().then(...) registers handlers on a later microtask/tick.
  const deadline = Date.now() + 5000;
  while (!handlers.has("repositories:add") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return { handlers, sentEvents };
}

function makeGitFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-gitfixture-"));

  fs.writeFileSync(path.join(root, "index.js"), "const a = 1;\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "print('hi')\n");

  const git = (args) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-m", "init"]);

  return root;
}

test("repositories:add clones, indexes, and reports progress before persisting", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-userdata-"));
  const repo = makeGitFixtureRepo();
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;
  const { handlers, sentEvents } = await loadMain({ userData });

  const add = handlers.get("repositories:add");
  assert.ok(add, "repositories:add handler must be registered");

  const result = await add({ sender: {} }, repoUrl);

  assert.strictEqual(result.name, path.basename(repo));
  assert.ok(path.isAbsolute(result.localPath));
  // id and folder name come from a single deterministic slug (no second clock read)
  assert.strictEqual(path.basename(result.localPath), result.id);

  // Progress was pushed to the renderer window during indexing.
  const progress = sentEvents
    .filter((event) => event.channel === "index-progress")
    .map((event) => event.payload);
  assert.deepStrictEqual(progress[0], {
    completed: 0,
    total: 2,
    currentFile: null,
  });
  assert.deepStrictEqual(progress.at(-1), {
    completed: 2,
    total: 2,
    currentFile: null,
  });

  // Files landed in SQLite...
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  const db = initializeDatabase(dbPath);
  const repoRow = db.prepare("SELECT id FROM repos").get();
  assert.ok(repoRow, "repo row must exist");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(
      repoRow.id,
    ).n,
    2,
  );

  // ...and the repository list is served from SQLite.
  const list = handlers.get("repositories:list");
  const repositories = await list({ sender: {} });
  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, result.id);
  assert.strictEqual(repositories[0].localPath, result.localPath);
  assert.strictEqual(repositories[0].url, repoUrl);
  assert.strictEqual(repositories[0].fileCount, 2);
});

test("migrates a legacy repositories.json into SQLite on startup", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-userdata-"));
  const atlasData = path.join(userData, "atlas-data");
  fs.mkdirSync(atlasData, { recursive: true });
  fs.writeFileSync(
    path.join(atlasData, "repositories.json"),
    JSON.stringify([
      {
        id: "legacy-slug-1",
        name: "legacy",
        url: "https://example.com/legacy.git",
        localPath: path.join(atlasData, "repositories", "legacy-slug-1"),
        addedAt: "2025-01-01T00:00:00.000Z",
      },
    ]),
    "utf8",
  );

  const { handlers } = await loadMain({ userData });
  const repositories = await handlers.get("repositories:list")({ sender: {} });

  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, "legacy-slug-1");
  assert.strictEqual(repositories[0].url, "https://example.com/legacy.git");
  assert.strictEqual(repositories[0].addedAt, "2025-01-01T00:00:00.000Z");
});

test("a malformed legacy repositories.json does not stop the app starting", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-userdata-"));
  const atlasData = path.join(userData, "atlas-data");
  fs.mkdirSync(atlasData, { recursive: true });
  // Two entries sharing an id but pointing at different paths collide on the
  // unique external_id index, which is what makes the import throw.
  fs.writeFileSync(
    path.join(atlasData, "repositories.json"),
    JSON.stringify([
      { id: "dupe", name: "a", localPath: path.join(atlasData, "repositories", "a") },
      { id: "dupe", name: "b", localPath: path.join(atlasData, "repositories", "b") },
    ]),
    "utf8",
  );

  const { handlers } = await loadMain({ userData });

  // Startup completed: the IPC handlers were registered after the migration.
  assert.ok(handlers.has("repositories:add"));
  // The failed import rolled back, leaving no partial rows.
  const repositories = await handlers.get("repositories:list")({ sender: {} });
  assert.deepStrictEqual(repositories, []);
});

test("startup backfill indexes a repository that was never indexed", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-userdata-"));
  const repo = makeGitFixtureRepo();
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Seed an unindexed row the way the legacy import would have, then let the
  // app's startup backfill pick it up.
  initializeDatabase(dbPath)
    .prepare(
      `INSERT INTO repos (name, root_path, url, added_at, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("legacy-name", repo, "https://example.com/legacy.git", "2025-01-01T00:00:00.000Z", "legacy-1");

  const { handlers, sentEvents } = await loadMain({ userData });

  // The backfill runs after the window opens, so poll until it lands.
  const list = handlers.get("repositories:list");
  const deadline = Date.now() + 5000;
  let repositories = await list({ sender: {} });

  while (Date.now() < deadline && repositories[0]?.fileCount !== 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    repositories = await list({ sender: {} });
  }

  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, "legacy-1");
  assert.strictEqual(repositories[0].fileCount, 2);
  // Backfill updates the existing row rather than duplicating or re-cloning it.
  assert.strictEqual(repositories[0].localPath, repo);
  assert.strictEqual(repositories[0].url, "https://example.com/legacy.git");
  assert.strictEqual(repositories[0].addedAt, "2025-01-01T00:00:00.000Z");

  assert.ok(
    sentEvents.some((event) => event.channel === "repositories:changed"),
    "renderer must be told to refresh once backfill completes",
  );
});
