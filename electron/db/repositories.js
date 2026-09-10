const { getDb } = require("./schema");

const REPOSITORY_COLUMNS =
  "id, name, root_path, url, added_at, external_id, file_count";

const LEGACY_IMPORTED_KEY = "legacy_repositories_imported";

// Shapes a SQLite row into the repository object the renderer consumes. The
// string `id` preferred by the UI is `external_id`; rows created before that
// column existed fall back to their numeric primary key.
function mapRepositoryRow(row) {
  if (!row) return null;

  return {
    id: row.external_id ?? String(row.id),
    name: row.name,
    url: row.url ?? "",
    localPath: row.root_path,
    addedAt: row.added_at ?? null,
    fileCount: row.file_count ?? 0,
  };
}

function listRepositories() {
  const rows = getDb()
    .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repos ORDER BY id DESC`)
    .all();

  return rows.map(mapRepositoryRow);
}

// Repositories whose index never completed: rows imported from the legacy
// JSON store, or written before indexing existed. The startup backfill walks
// these and hands the metadata back to the indexer so the existing row is
// updated in place rather than duplicated.
function listUnindexedRepositories() {
  const rows = getDb()
    .prepare(
      `SELECT ${REPOSITORY_COLUMNS} FROM repos WHERE indexed_at IS NULL ORDER BY id`,
    )
    .all();

  return rows.map((row) => ({
    id: row.external_id ?? String(row.id),
    name: row.name,
    localPath: row.root_path,
    url: row.url ?? null,
    addedAt: row.added_at ?? null,
    externalId: row.external_id ?? null,
  }));
}

function findRepository(repositoryId) {
  if (repositoryId === undefined || repositoryId === null) return null;

  const db = getDb();
  const byExternalId = db
    .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repos WHERE external_id = ?`)
    .get(String(repositoryId));

  if (byExternalId) return mapRepositoryRow(byExternalId);

  // Legacy rows (or callers using the numeric primary key) still resolve.
  if (/^\d+$/.test(String(repositoryId))) {
    const byPrimaryKey = db
      .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repos WHERE id = ?`)
      .get(Number(repositoryId));

    if (byPrimaryKey) return mapRepositoryRow(byPrimaryKey);
  }

  return null;
}

function legacyRepositoriesImported() {
  const row = getDb()
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(LEGACY_IMPORTED_KEY);

  return row?.value === "1";
}

// One-time import of the pre-SQLite repositories.json store. Existing rows are
// preserved: metadata from the legacy file is only filled in where the row does
// not already have a value, so an already-indexed repository keeps its
// file_count.
function importLegacyRepositories(legacyRepositories) {
  if (!Array.isArray(legacyRepositories) || legacyRepositories.length === 0) {
    return 0;
  }

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO repos (name, root_path, url, added_at, external_id, indexed_at, file_count)
    VALUES (@name, @rootPath, @url, @addedAt, @externalId, NULL, 0)
    ON CONFLICT(root_path) DO UPDATE SET
      name = COALESCE(excluded.name, repos.name),
      url = COALESCE(excluded.url, repos.url),
      added_at = COALESCE(excluded.added_at, repos.added_at),
      external_id = COALESCE(excluded.external_id, repos.external_id)
  `);
  const markImported = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'
  `);

  const imported = [];

  const runImport = db.transaction((repositories) => {
    for (const repository of repositories) {
      if (!repository || !repository.localPath) continue;

      upsert.run({
        name: repository.name ?? null,
        rootPath: repository.localPath,
        url: repository.url ?? null,
        addedAt: repository.addedAt ?? null,
        externalId: repository.id ?? null,
      });

      imported.push(repository);
    }

    markImported.run(LEGACY_IMPORTED_KEY);
  });

  runImport(legacyRepositories);

  return imported.length;
}

module.exports = {
  mapRepositoryRow,
  listRepositories,
  listUnindexedRepositories,
  findRepository,
  legacyRepositoriesImported,
  importLegacyRepositories,
};
