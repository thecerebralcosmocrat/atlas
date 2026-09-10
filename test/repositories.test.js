const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const {
  listRepositories,
  listUnindexedRepositories,
  findRepository,
  legacyRepositoriesImported,
  importLegacyRepositories,
} = require("../electron/db/repositories");

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-reposdb-"));
  return initializeDatabase(path.join(dir, "atlas.db"));
}

test("lists an empty database as no repositories", () => {
  freshDb();
  assert.deepStrictEqual(listRepositories(), []);
});

test("maps rows to the renderer's repository shape", () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO repos (name, root_path, url, added_at, external_id, file_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "atlas",
    "C:/data/repos/atlas-1",
    "https://example.com/atlas.git",
    "2026-01-02T03:04:05.000Z",
    "atlas-1",
    7,
  );

  assert.deepStrictEqual(listRepositories(), [
    {
      id: "atlas-1",
      name: "atlas",
      url: "https://example.com/atlas.git",
      localPath: "C:/data/repos/atlas-1",
      addedAt: "2026-01-02T03:04:05.000Z",
      fileCount: 7,
    },
  ]);
});

test("findRepository resolves external ids and numeric primary keys", () => {
  const db = freshDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("atlas", "C:/data/repos/atlas-1", "atlas-1");

  assert.strictEqual(findRepository("atlas-1").name, "atlas");
  assert.strictEqual(findRepository(String(lastInsertRowid)).name, "atlas");
  assert.strictEqual(findRepository("missing"), null);
  assert.strictEqual(findRepository(null), null);
});

test("falls back to the numeric id when external_id is absent", () => {
  const db = freshDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO repos (name, root_path) VALUES (?, ?)")
    .run("legacy", "C:/data/repos/legacy");

  const repository = listRepositories()[0];
  assert.strictEqual(repository.id, String(lastInsertRowid));
  assert.strictEqual(findRepository(repository.id).name, "legacy");
});

test("lists only repositories that have never been indexed", () => {
  const db = freshDb();
  db.prepare("INSERT INTO repos (name, root_path) VALUES (?, ?)").run(
    "unindexed",
    "C:/data/repos/unindexed",
  );
  db.prepare(
    "INSERT INTO repos (name, root_path, indexed_at, file_count) VALUES (?, ?, ?, ?)",
  ).run("indexed", "C:/data/repos/indexed", 123, 5);

  assert.deepStrictEqual(listUnindexedRepositories(), [
    {
      id: "1",
      name: "unindexed",
      localPath: "C:/data/repos/unindexed",
      url: null,
      addedAt: null,
      externalId: null,
    },
  ]);
});

test("imports a legacy JSON repository and records the marker", () => {
  freshDb();

  assert.strictEqual(legacyRepositoriesImported(), false);

  const imported = importLegacyRepositories([
    {
      id: "old-slug-1",
      name: "old",
      url: "https://example.com/old.git",
      localPath: "C:/data/repos/old-slug-1",
      addedAt: "2025-05-06T07:08:09.000Z",
    },
  ]);

  assert.strictEqual(imported, 1);
  assert.strictEqual(legacyRepositoriesImported(), true);

  const [repository] = listRepositories();
  assert.strictEqual(repository.id, "old-slug-1");
  assert.strictEqual(repository.url, "https://example.com/old.git");
  assert.strictEqual(repository.localPath, "C:/data/repos/old-slug-1");
  assert.strictEqual(repository.addedAt, "2025-05-06T07:08:09.000Z");
});

test("import fills in legacy metadata while preserving the indexed file count", () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO repos (name, root_path, indexed_at, file_count, external_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("slug-12345", "C:/data/repos/same-path", 123, 42, "modern-1");

  importLegacyRepositories([
    {
      id: "modern-1",
      name: "friendly-name",
      url: "https://example.com/same.git",
      localPath: "C:/data/repos/same-path",
      addedAt: "2024-01-01T00:00:00.000Z",
    },
  ]);

  const [repository] = listRepositories();
  assert.strictEqual(repository.name, "friendly-name");
  assert.strictEqual(repository.fileCount, 42);
  assert.strictEqual(repository.url, "https://example.com/same.git");
  assert.strictEqual(repository.addedAt, "2024-01-01T00:00:00.000Z");
});

test("re-importing the same legacy file does not duplicate repositories", () => {
  freshDb();
  const legacy = [
    { id: "dupe-1", name: "dupe", localPath: "C:/data/repos/dupe-1" },
  ];

  importLegacyRepositories(legacy);
  importLegacyRepositories(legacy);

  assert.strictEqual(listRepositories().length, 1);
});
