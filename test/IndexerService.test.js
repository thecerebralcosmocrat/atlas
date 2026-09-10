const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-indexdb-"));
  return path.join(dir, "atlas.db");
}

function makeFixtureRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-indexrepo-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function fakeWindow() {
  const events = [];
  return {
    events,
    webContents: {
      send: (channel, payload) => events.push({ channel, payload }),
    },
  };
}

function countRepos(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM repos").get().n;
}

function countFiles(db, repoId) {
  return db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(repoId)
    .n;
}

test("indexes in-scope source files into repos and files", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/index.js": "const a = 1;\n",
    "src/util.ts": "export const b = 2;\n",
    "README.md": "# not indexed\n",
  });

  const result = await new IndexerService().indexRepo(repo, fakeWindow());

  assert.strictEqual(countRepos(db), 1);
  assert.strictEqual(result.fileCount, 2);
  assert.strictEqual(countFiles(db, result.repoId), 2);

  const row = db
    .prepare("SELECT file_count, indexed_at FROM repos WHERE id = ?")
    .get(result.repoId);
  assert.strictEqual(row.file_count, 2);
  assert.ok(row.indexed_at > 0);
});

test("re-indexing the same path updates in place instead of throwing", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "a.js": "let a;\n",
    "b.js": "let b;\n",
  });
  const indexer = new IndexerService();

  const first = await indexer.indexRepo(repo, fakeWindow());
  const second = await indexer.indexRepo(repo, fakeWindow());

  assert.strictEqual(countRepos(db), 1);
  assert.strictEqual(first.repoId, second.repoId);
  assert.strictEqual(countFiles(db, second.repoId), 2);
});

test("re-indexing drops files that no longer exist", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "a.js": "let a;\n",
    "b.js": "let b;\n",
  });
  const indexer = new IndexerService();

  await indexer.indexRepo(repo, fakeWindow());
  fs.rmSync(path.join(repo, "b.js"));
  const result = await indexer.indexRepo(repo, fakeWindow());

  assert.strictEqual(result.fileCount, 1);
  assert.strictEqual(countFiles(db, result.repoId), 1);
  assert.strictEqual(countRepos(db), 1);
});

test("indexing a different path keeps both repositories", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const indexer = new IndexerService();
  const repoA = makeFixtureRepo({ "a.js": "let a;\n" });
  const repoB = makeFixtureRepo({ "b.js": "let b;\n" });

  const first = await indexer.indexRepo(repoA, fakeWindow());
  const second = await indexer.indexRepo(repoB, fakeWindow());

  assert.notStrictEqual(first.repoId, second.repoId);
  assert.strictEqual(countRepos(db), 2);
});
