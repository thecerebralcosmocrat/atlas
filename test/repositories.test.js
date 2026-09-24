const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const {
  listRepositories,
  listUnindexedRepositories,
  listRepositoriesWithoutChunks,
  findRepository,
  deleteRepository,
  legacyRepositoriesImported,
  importLegacyRepositories,
} = require("../electron/db/repositories");
const { encodeVector } = require("../electron/query/vectors");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

// The model the chunk backfill is asked about. Chunks are only "already there"
// for the model that produced them.
const EMBED_MODEL = "test-embed";

function freshDb() {
  const dir = makeTempDir("atlas-reposdb-");
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

// Inserts an indexed repository with one file, and optionally one chunk on
// that file, so the chunk backfill query has something to select from.
function insertIndexedRepo(db, name, { withChunk = false } = {}) {
  const { lastInsertRowid: repoId } = db
    .prepare(
      `INSERT INTO repos (name, root_path, indexed_at, file_count)
       VALUES (?, ?, ?, ?)`,
    )
    .run(name, `C:/data/repos/${name}`, 123, 1);
  const { lastInsertRowid: fileId } = db
    .prepare(
      `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(repoId, `${name}.js`, `C:/abs/${name}.js`, "js", 1, "let a;\n", 123);

  if (withChunk) {
    db.prepare(
      `INSERT INTO chunks (file_id, ordinal, start_line, end_line, content, embedding, dims, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 0, 1, 1, "let a;", encodeVector([1, 0]), 2, EMBED_MODEL);
  }

  return Number(repoId);
}

test("lists indexed repositories that have no chunks yet", () => {
  const db = freshDb();
  insertIndexedRepo(db, "pre-chunking");
  insertIndexedRepo(db, "already-chunked", { withChunk: true });
  // Never indexed, so the chunk backfill must leave it to the indexing backfill.
  db.prepare("INSERT INTO repos (name, root_path) VALUES (?, ?)").run(
    "unindexed",
    "C:/data/repos/unindexed",
  );

  assert.deepStrictEqual(listRepositoriesWithoutChunks(EMBED_MODEL), [
    {
      id: "1",
      name: "pre-chunking",
      localPath: "C:/data/repos/pre-chunking",
      url: null,
      addedAt: null,
      externalId: null,
    },
  ]);
});

test("skips an indexed repository whose last index found no files", () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO repos (name, root_path, indexed_at, file_count) VALUES (?, ?, ?, ?)",
  ).run("empty", "C:/data/repos/empty", 123, 0);

  // Nothing to chunk means a re-index would produce no chunks again, so it
  // would be retried on every launch for nothing.
  assert.deepStrictEqual(listRepositoriesWithoutChunks(EMBED_MODEL), []);
});

test("skips a repository when any one of its files has chunks", () => {
  const db = freshDb();
  const repoId = insertIndexedRepo(db, "partial");
  db.prepare(
    `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, "second.js", "C:/abs/second.js", "js", 1, "let b;\n", 123);
  db.prepare(
    `INSERT INTO chunks (file_id, ordinal, start_line, end_line, content, embedding, dims, model)
     SELECT id, 0, 1, 1, 'let a;', ?, 2, '${EMBED_MODEL}' FROM files WHERE path = 'partial.js'`,
  ).run(encodeVector([1, 0]));

  assert.deepStrictEqual(listRepositoriesWithoutChunks(EMBED_MODEL), []);
});

test("re-lists a repository whose chunks came from a different model", () => {
  const db = freshDb();
  insertIndexedRepo(db, "old-model", { withChunk: true });

  // Chunks from a model that is no longer configured sit in a different vector
  // space and are filtered out of retrieval, so they must not count as
  // chunked for the model in use now.
  assert.deepStrictEqual(
    listRepositoriesWithoutChunks("new-model").map((repo) => repo.name),
    ["old-model"],
  );
  assert.deepStrictEqual(listRepositoriesWithoutChunks(EMBED_MODEL), []);
});

// Seeds an indexed repository with one file plus the rows derived from it, so
// a delete can be checked against every table a repository owns.
function insertDerivedRows(db, name) {
  const repoId = insertIndexedRepo(db, name, { withChunk: true });
  const fileId = db
    .prepare("SELECT id FROM files WHERE repo_id = ?")
    .get(repoId).id;

  db.prepare(
    `INSERT INTO symbols (file_id, name, kind, signature, line_start, line_end, is_exported)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(fileId, "a", "variable", "let a", 1, 1, 0);

  return { repoId, fileId };
}

test("deletes a repository and every row derived from it", () => {
  const db = freshDb();
  const doomed = insertDerivedRows(db, "doomed");
  const kept = insertDerivedRows(db, "kept");
  // An import crossing repos must go when either end is deleted, since it
  // references file ids that no longer exist.
  db.prepare(
    `INSERT INTO imports (source_file_id, target_file_id, import_specifier, import_type, resolved_external)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(doomed.fileId, kept.fileId, "./kept", "esm", 0);

  assert.strictEqual(deleteRepository(doomed.repoId), 1);

  assert.deepStrictEqual(
    listRepositories().map((repository) => repository.name),
    ["kept"],
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(
      doomed.repoId,
    ).n,
    0,
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?").get(
      doomed.fileId,
    ).n,
    0,
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_id = ?").get(
      doomed.fileId,
    ).n,
    0,
  );
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM imports").get().n, 0);

  // The untouched repository keeps everything it had.
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(
      kept.repoId,
    ).n,
    1,
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_id = ?").get(
      kept.fileId,
    ).n,
    1,
  );
});

test("deletes a repository addressed by its external id", () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)",
  ).run("atlas", "C:/data/repos/atlas-1", "atlas-1");

  assert.strictEqual(deleteRepository("atlas-1"), 1);
  assert.deepStrictEqual(listRepositories(), []);
});

test("deleting an unknown repository removes nothing", () => {
  const db = freshDb();
  insertDerivedRows(db, "survivor");

  assert.strictEqual(deleteRepository("missing"), 0);
  assert.strictEqual(deleteRepository(undefined), 0);
  assert.strictEqual(deleteRepository(null), 0);
  assert.strictEqual(listRepositories().length, 1);
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
