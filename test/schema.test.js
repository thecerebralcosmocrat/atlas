const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Database = require("better-sqlite3");

const { initializeDatabase } = require("../electron/db/schema");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function makeTempDbPath() {
  const dir = makeTempDir("atlas-schema-");
  return path.join(dir, "atlas.db");
}

test("creates the expected tables", () => {
  const db = initializeDatabase(makeTempDbPath());
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  for (const expected of ["repos", "files", "imports", "symbols", "workspaces", "profile_settings"]) {
    assert.ok(tables.includes(expected), `expected table '${expected}'`);
  }
});

test("seeds exactly one default workspace", () => {
  const db = initializeDatabase(makeTempDbPath());
  const workspaces = db.prepare("SELECT * FROM workspaces").all();

  assert.strictEqual(workspaces.length, 1);
  assert.strictEqual(workspaces[0].name, "Personal");
  assert.strictEqual(workspaces[0].is_default, 1);
});

test("adopts repositories from a database that predates workspaces", () => {
  const dbPath = makeTempDbPath();
  const legacy = new Database(dbPath);

  legacy.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      root_path TEXT UNIQUE,
      indexed_at INTEGER,
      file_count INTEGER
    )
  `);
  legacy.prepare("INSERT INTO repos (name, root_path) VALUES (?, ?)").run(
    "old",
    "/tmp/atlas-old",
  );
  legacy.close();

  const db = initializeDatabase(dbPath);
  const { id: defaultId } = db
    .prepare("SELECT id FROM workspaces WHERE is_default = 1")
    .get();
  const repository = db.prepare("SELECT workspace_id FROM repos").get();

  // A repository must never disappear from the sidebar just because it was
  // indexed before workspaces existed.
  assert.strictEqual(repository.workspace_id, defaultId);
});

test("is idempotent for the same path", () => {
  const dbPath = makeTempDbPath();
  const first = initializeDatabase(dbPath);
  const second = initializeDatabase(dbPath);

  assert.strictEqual(first, second);
});

test("repos.root_path is unique", () => {
  const db = initializeDatabase(makeTempDbPath());
  const insert = db.prepare("INSERT INTO repos (name, root_path) VALUES (?, ?)");

  insert.run("first", "/tmp/atlas-unique");

  assert.throws(
    () => insert.run("second", "/tmp/atlas-unique"),
    /UNIQUE constraint failed/,
  );
});

test("migrates a legacy database missing the repository metadata columns", () => {
  const dbPath = makeTempDbPath();
  const legacy = new Database(dbPath);

  legacy.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      root_path TEXT UNIQUE,
      indexed_at INTEGER,
      file_count INTEGER
    )
  `);
  legacy.close();

  const db = initializeDatabase(dbPath);
  const columns = db
    .prepare("PRAGMA table_info(repos)")
    .all()
    .map((row) => row.name);

  for (const expected of ["url", "added_at", "external_id", "workspace_id"]) {
    assert.ok(columns.includes(expected), `expected column '${expected}'`);
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("meta"), "expected meta table");
});

test("repos.external_id is unique", () => {
  const db = initializeDatabase(makeTempDbPath());
  const insert = db.prepare(
    "INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)",
  );

  insert.run("first", "/tmp/atlas-ext-a", "ext-1");

  assert.throws(
    () => insert.run("second", "/tmp/atlas-ext-b", "ext-1"),
    /UNIQUE constraint failed/,
  );
});
