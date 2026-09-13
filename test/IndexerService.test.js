const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function makeTempDbPath() {
  const dir = makeTempDir("atlas-indexdb-");
  return path.join(dir, "atlas.db");
}

function makeFixtureRepo(files) {
  const root = makeTempDir("atlas-indexrepo-");

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

test("aborts without committing when indexing exceeds its timeout", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n" });

  await assert.rejects(
    () => new IndexerService().indexRepo(repo, fakeWindow(), {}, { timeoutMs: 0 }),
    /timed out/i,
  );

  // The deadline is checked before the synchronous write transaction, so the
  // abandoned index leaves no partial rows behind.
  assert.strictEqual(countRepos(db), 0);
});

test("a renderer that throws on send cannot fail an already-committed index", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n" });
  // A window torn down mid-index makes webContents.send throw. That must not
  // propagate: repositories:add would otherwise delete the folder while the
  // committed repos row survives, pointing at a path that no longer exists.
  const destroyedWindow = {
    webContents: {
      send() {
        throw new Error("Object has been destroyed");
      },
    },
  };

  const result = await new IndexerService().indexRepo(repo, destroyedWindow);

  assert.strictEqual(result.fileCount, 1);
  assert.strictEqual(countRepos(db), 1);
  assert.strictEqual(countFiles(db, result.repoId), 1);
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

test("indexes symbols and links relative imports to the target file", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/a.js": [
      'import { helper } from "./b";',
      "",
      "export function alpha() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "src/b.js": "export function helper() {\n  return 1;\n}\n",
  });

  const result = await new IndexerService().indexRepo(repo, fakeWindow());

  assert.strictEqual(result.symbolCount, 2);
  assert.strictEqual(result.importCount, 1);

  const row = db
    .prepare(
      `SELECT i.target_file_id, i.resolved_external, f.path AS target_path
         FROM imports i
         LEFT JOIN files f ON f.id = i.target_file_id
        WHERE i.source_file_id IN (SELECT id FROM files WHERE repo_id = ? AND path LIKE '%a.js')`,
    )
    .get(result.repoId);

  assert.strictEqual(row.resolved_external, 0);
  assert.strictEqual(row.target_path, path.join("src", "b.js"));
});

test("marks a bare package import as external", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/a.js": 'import React from "react";\nexport const view = () => null;\n',
  });

  const result = await new IndexerService().indexRepo(repo, fakeWindow());

  const row = db
    .prepare(
      `SELECT target_file_id, resolved_external, import_specifier
         FROM imports
        WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)`,
    )
    .get(result.repoId);

  assert.strictEqual(row.import_specifier, "react");
  assert.strictEqual(row.target_file_id, null);
  assert.strictEqual(row.resolved_external, 1);
});

test("re-indexing replaces symbols and imports instead of duplicating them", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/a.js": 'import x from "x";\nexport function alpha() {\n  return x;\n}\n',
  });
  const indexer = new IndexerService();

  const first = await indexer.indexRepo(repo, fakeWindow());
  const second = await indexer.indexRepo(repo, fakeWindow());

  assert.strictEqual(second.symbolCount, first.symbolCount);

  const symbolRows = db
    .prepare(
      "SELECT COUNT(*) AS n FROM symbols WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)",
    )
    .get(second.repoId).n;
  const importRows = db
    .prepare(
      "SELECT COUNT(*) AS n FROM imports WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)",
    )
    .get(second.repoId).n;

  assert.strictEqual(symbolRows, first.symbolCount);
  assert.strictEqual(importRows, first.importCount);
});
