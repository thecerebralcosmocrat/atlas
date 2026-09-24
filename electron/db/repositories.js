const { getDb } = require("./schema");

const REPOSITORY_COLUMNS =
  "id, name, root_path, url, added_at, external_id, file_count, indexed_at, commit_sha, sync_state";

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
    indexedAt: row.indexed_at ?? null,
    commitSha: row.commit_sha ?? null,
    syncState: row.sync_state ?? null,
  };
}

function listRepositories() {
  const rows = getDb()
    .prepare(`SELECT ${REPOSITORY_COLUMNS} FROM repos ORDER BY id DESC`)
    .all();

  return rows.map(mapRepositoryRow);
}

// The metadata the indexer needs to re-index an existing row in place instead
// of duplicating it. Also carries the sync bookkeeping, so the sync poller can
// reuse the same query shape as the backfill.
function mapIndexTargetRow(row) {
  return {
    id: row.external_id ?? String(row.id),
    name: row.name,
    localPath: row.root_path,
    url: row.url ?? null,
    addedAt: row.added_at ?? null,
    externalId: row.external_id ?? null,
    commitSha: row.commit_sha ?? null,
    syncState: row.sync_state ?? null,
  };
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

  return rows.map(mapIndexTargetRow);
}

// Repositories indexed before chunking existed: they have files but no chunks,
// so semantic retrieval would silently fall back to lexical for them. Only
// worth reporting when an embedder is configured, which the caller decides.
//
// `model` is the configured embed model, and only its chunks count as already
// present. A chunk left behind by a model that is no longer configured lives in
// a different vector space that `semanticSearch` filters out, so such a
// repository still needs the backfill even though its `chunks` table is not
// empty.
//
// The `EXISTS a file` guard keeps a repository whose last index found no files
// out of the backfill, since re-indexing it would produce no chunks again. A
// repository whose files exist but produced no chunks is retried on the next
// launch: an embed that failed (offline, rate limited) should be retried, and a
// repository with nothing worth chunking costs one re-read and no request.
function listRepositoriesWithoutChunks(model) {
  const rows = getDb()
    .prepare(
      `SELECT ${REPOSITORY_COLUMNS} FROM repos
        WHERE indexed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM files f WHERE f.repo_id = repos.id)
          AND NOT EXISTS (
            SELECT 1 FROM chunks c
             JOIN files f ON f.id = c.file_id
            WHERE f.repo_id = repos.id
              AND c.model = ?
          )
        ORDER BY id`,
    )
    .all(model);

  return rows.map(mapIndexTargetRow);
}

// Repositories the sync poller can refresh: they came from a remote, and they
// have been indexed at least once, so there is a known-good state to compare
// against. Never-indexed rows are left to the startup backfill so the two
// passes do not both read the same folder.
function listSyncableRepositories() {
  const rows = getDb()
    .prepare(
      `SELECT ${REPOSITORY_COLUMNS} FROM repos
        WHERE url IS NOT NULL AND url != '' AND indexed_at IS NOT NULL
        ORDER BY id`,
    )
    .all();

  return rows.map(mapIndexTargetRow);
}

// Records the commit the clone now matches and whether local edits are holding
// a remote update back. `syncState` is null when nothing is holding it up.
function setRepositorySyncState(repositoryId, { commitSha, syncState }) {
  const rowId = resolveRepositoryRowId(repositoryId);

  if (rowId === null) return 0;

  return getDb()
    .prepare("UPDATE repos SET commit_sha = ?, sync_state = ? WHERE id = ?")
    .run(commitSha ?? null, syncState ?? null, rowId).changes;
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

// The numeric primary key behind a caller-visible id, so the cascade deletes
// below can be keyed on repo_id. Mirrors findRepository's resolution order:
// external_id first, then the numeric primary key for legacy rows.
function resolveRepositoryRowId(repositoryId) {
  if (repositoryId === undefined || repositoryId === null) return null;

  const db = getDb();
  const byExternalId = db
    .prepare("SELECT id FROM repos WHERE external_id = ?")
    .get(String(repositoryId));

  if (byExternalId) return byExternalId.id;

  if (/^\d+$/.test(String(repositoryId))) {
    const byPrimaryKey = db
      .prepare("SELECT id FROM repos WHERE id = ?")
      .get(Number(repositoryId));

    if (byPrimaryKey) return byPrimaryKey.id;
  }

  return null;
}

// Removes a repository and everything derived from it. Files, symbols, chunks,
// and imports are all keyed by file, and nothing cascades in SQLite, so they
// have to go before the repo row — otherwise deleting the row would leave
// orphans that a later re-index of the same path would inherit. `imports`
// references files on both ends, so both sides must be cleared.
//
// Returns the number of repository rows removed (0 when the id matches
// nothing), which the caller uses to distinguish "deleted" from "not found".
function deleteRepository(repositoryId) {
  const rowId = resolveRepositoryRowId(repositoryId);

  if (rowId === null) return 0;

  const db = getDb();
  const deleteSymbols = db.prepare(
    "DELETE FROM symbols WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)",
  );
  const deleteImports = db.prepare(`
    DELETE FROM imports
    WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)
       OR target_file_id IN (SELECT id FROM files WHERE repo_id = ?)
  `);
  const deleteChunks = db.prepare(
    "DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)",
  );
  const deleteFiles = db.prepare("DELETE FROM files WHERE repo_id = ?");
  const deleteRepo = db.prepare("DELETE FROM repos WHERE id = ?");

  const runDelete = db.transaction(() => {
    deleteSymbols.run(rowId);
    deleteImports.run(rowId, rowId);
    deleteChunks.run(rowId);
    deleteFiles.run(rowId);

    return deleteRepo.run(rowId).changes;
  });

  return runDelete();
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
  listRepositoriesWithoutChunks,
  listSyncableRepositories,
  findRepository,
  deleteRepository,
  setRepositorySyncState,
  legacyRepositoriesImported,
  importLegacyRepositories,
};
