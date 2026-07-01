const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

let db = null;
let dbPath = null;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    root_path TEXT UNIQUE,
    indexed_at INTEGER,
    file_count INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER,
    path TEXT,
    abs_path TEXT,
    language TEXT,
    loc INTEGER,
    raw_content TEXT,
    indexed_at INTEGER,
    UNIQUE(repo_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER,
    target_file_id INTEGER,
    import_specifier TEXT,
    import_type TEXT,
    resolved_external INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER,
    name TEXT,
    kind TEXT,
    signature TEXT,
    line_start INTEGER,
    line_end INTEGER,
    is_exported INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_repo_id_path ON files(repo_id, path)`,
  `CREATE INDEX IF NOT EXISTS idx_imports_source_file_id ON imports(source_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id)`,
];

function getDefaultDbPath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "atlas-data", "atlas.db");
}

function initializeDatabase(resolvedDbPath) {
  if (db && dbPath === resolvedDbPath) {
    return db;
  }

  if (db) {
    db.close();
    db = null;
  }

  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

  db = new Database(resolvedDbPath);
  db.pragma("journal_mode = WAL");

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  dbPath = resolvedDbPath;
  return db;
}

function getDb() {
  if (!db) {
    initializeDatabase(dbPath ?? getDefaultDbPath());
  }

  return db;
}

module.exports = { initializeDatabase, getDb };
