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
    file_count INTEGER,
    url TEXT,
    added_at TEXT,
    external_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
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
  // Embeddable slices of a file, with the vector stored as a Float32 BLOB. The
  // source of truth for repository content stays `files`; chunks exist so a
  // question can be matched against meaning rather than literal terms. `model`
  // records which embedding model produced the vector, so chunks embedded by a
  // model that is no longer configured are skipped instead of scored against
  // an incompatible vector space.
  `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER,
    ordinal INTEGER,
    start_line INTEGER,
    end_line INTEGER,
    content TEXT,
    embedding BLOB,
    dims INTEGER,
    model TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_repo_id_path ON files(repo_id, path)`,
  `CREATE INDEX IF NOT EXISTS idx_imports_source_file_id ON imports(source_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)`,
  // Names are compared case-insensitively so "Work" and "work" cannot both
  // exist and make the switcher ambiguous.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_name
     ON workspaces(name COLLATE NOCASE)`,
];

// Columns added after the original schema shipped. `CREATE TABLE IF NOT EXISTS`
// cannot add columns to an existing database, so legacy databases are migrated
// by inspecting the current table and adding whatever is missing.
const REPOSITORY_COLUMNS = [
  ["url", "TEXT"],
  ["added_at", "TEXT"],
  ["external_id", "TEXT"],
  // The commit whose content was last indexed. The sync poller compares it
  // against the remote head to decide whether anything needs re-indexing.
  ["commit_sha", "TEXT"],
  // NULL when in sync with the remote, "dirty" when the clone has local edits
  // that hold the remote update back.
  ["sync_state", "TEXT"],
  // The workspace a repository is filed under. NULL is only possible in a
  // database from before workspaces existed; ensureDefaultWorkspace adopts
  // those rows on startup.
  ["workspace_id", "INTEGER"],
];

const DEFAULT_WORKSPACE_NAME = "Personal";
const DEFAULT_WORKSPACE_DESCRIPTION = "Local projects and experiments";

function ensureRepositoryColumns(database) {
  const existingColumns = new Set(
    database.prepare("PRAGMA table_info(repos)").all().map((row) => row.name),
  );

  for (const [name, type] of REPOSITORY_COLUMNS) {
    if (!existingColumns.has(name)) {
      database.exec(`ALTER TABLE repos ADD COLUMN ${name} ${type}`);
    }
  }

  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_external_id ON repos(external_id)",
  );
  // Indexed after the migration above, because `repos` is created without the
  // workspace column on a fresh database and legacy tables lack it entirely.
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_repos_workspace_id ON repos(workspace_id)",
  );
}

// Every database has exactly one default workspace. It is created before the
// first repository is added and adopted by rows from databases that predate
// workspaces, so a repository never disappears from the sidebar.
function ensureDefaultWorkspace(database) {
  let defaultWorkspace = database
    .prepare(
      "SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1",
    )
    .get();

  if (!defaultWorkspace) {
    // A database that already has workspaces but no default (for example one
    // written by a partial migration) promotes its oldest workspace rather
    // than adding a second, empty one.
    const oldestWorkspace = database
      .prepare("SELECT id FROM workspaces ORDER BY id LIMIT 1")
      .get();

    if (oldestWorkspace) {
      database
        .prepare("UPDATE workspaces SET is_default = 1 WHERE id = ?")
        .run(oldestWorkspace.id);
      defaultWorkspace = oldestWorkspace;
    } else {
      const result = database
        .prepare(
          `INSERT INTO workspaces (name, description, is_default, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(
          DEFAULT_WORKSPACE_NAME,
          DEFAULT_WORKSPACE_DESCRIPTION,
          new Date().toISOString(),
        );
      defaultWorkspace = { id: Number(result.lastInsertRowid) };
    }
  }

  database
    .prepare("UPDATE repos SET workspace_id = ? WHERE workspace_id IS NULL")
    .run(defaultWorkspace.id);

  return defaultWorkspace.id;
}

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

  ensureRepositoryColumns(db);
  ensureDefaultWorkspace(db);

  dbPath = resolvedDbPath;
  return db;
}

function getDb() {
  if (!db) {
    initializeDatabase(dbPath ?? getDefaultDbPath());
  }

  return db;
}

// Releases the single connection. Tests call this before deleting their temp
// directories; Windows refuses to remove a file while SQLite still holds it.
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }

  dbPath = null;
}

module.exports = {
  initializeDatabase,
  getDb,
  closeDatabase,
  ensureDefaultWorkspace,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_DESCRIPTION,
};
