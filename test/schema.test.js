const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { initializeDatabase } = require("../electron/db/schema");

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-schema-"));
  return path.join(dir, "atlas.db");
}

test("creates the expected tables", () => {
  const db = initializeDatabase(makeTempDbPath());
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  for (const expected of ["repos", "files", "imports", "symbols"]) {
    assert.ok(tables.includes(expected), `expected table '${expected}'`);
  }
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

  for (const expected of ["url", "added_at", "external_id"]) {
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
