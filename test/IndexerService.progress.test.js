const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-progressdb-"));
  return path.join(dir, "atlas.db");
}

function makeFixtureRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-progressrepo-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function captureWindow() {
  const events = [];
  return {
    events,
    webContents: {
      send: (channel, payload) => events.push({ channel, payload }),
    },
  };
}

function progressEvents(window) {
  return window.events.filter((event) => event.channel === "index-progress");
}

test("emits a starting and finishing progress event", async () => {
  initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "a.js": "let a;\n",
    "b.js": "let b;\n",
    "c.js": "let c;\n",
  });
  const window = captureWindow();

  await new IndexerService().indexRepo(repo, window);

  const progress = progressEvents(window).map((event) => event.payload);
  assert.ok(progress.length >= 2);
  assert.deepStrictEqual(progress[0], {
    completed: 0,
    total: 3,
    currentFile: null,
  });
  assert.deepStrictEqual(progress.at(-1), {
    completed: 3,
    total: 3,
    currentFile: null,
  });
  // Only the index-progress channel may be used, so the renderer subscription
  // in App.jsx cannot receive stray payloads.
  assert.ok(window.events.every((event) => event.channel === "index-progress"));
});

test("empty repository reports zero totals without dividing by zero", async () => {
  initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({});
  const window = captureWindow();

  await new IndexerService().indexRepo(repo, window);

  const progress = progressEvents(window).map((event) => event.payload);
  assert.deepStrictEqual(progress[0], {
    completed: 0,
    total: 0,
    currentFile: null,
  });
  assert.deepStrictEqual(progress.at(-1), {
    completed: 0,
    total: 0,
    currentFile: null,
  });
});

test("emits periodic ticks while walking a large repository", async () => {
  initializeDatabase(makeTempDbPath());
  const files = {};
  for (let i = 0; i < 60; i += 1) {
    files[`f${i}.js`] = `let x${i} = ${i};\n`;
  }
  const repo = makeFixtureRepo(files);
  const window = captureWindow();

  await new IndexerService().indexRepo(repo, window);

  const progress = progressEvents(window).map((event) => event.payload);
  const tick = progress.find(
    (payload) => payload.completed === 50 && payload.currentFile,
  );
  assert.ok(tick, "expected a tick at 50 files with the current file name");
  assert.strictEqual(tick.total, 60);
  assert.deepStrictEqual(progress.at(-1), {
    completed: 60,
    total: 60,
    currentFile: null,
  });
});
