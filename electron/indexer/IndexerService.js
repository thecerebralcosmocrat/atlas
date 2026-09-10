const fs = require("fs/promises");
const path = require("path");
const { getDb } = require("../db/schema");
const { FileTraverser } = require("./FileTraverser");

class IndexerService {
  async indexRepo(repoPath, mainWindow, metadata = {}) {
    const files = await new FileTraverser().traverse(repoPath);
    const total = files.length;
    const repoName = metadata.name ?? path.basename(repoPath);
    const rootPath = path.resolve(repoPath);
    const db = getDb();

    // Read file contents before the transaction: better-sqlite3 transactions
    // are synchronous, so all async I/O has to happen up front.
    const fileRecords = [];
    let completed = 0;

    mainWindow?.webContents?.send("index-progress", {
      completed: 0,
      total,
      currentFile: null,
    });

    for (const file of files) {
      try {
        const rawContent = await fs.readFile(file.absPath, "utf8");

        fileRecords.push({
          path: file.path,
          absPath: file.absPath,
          language: file.extension.slice(1),
          loc: file.loc,
          rawContent,
        });

        completed += 1;

        if (completed % 50 === 0) {
          mainWindow?.webContents?.send("index-progress", {
            completed,
            total,
            currentFile: file.path,
          });
        }
      } catch {
        continue;
      }
    }

    const indexedAt = Date.now();

    const upsertRepo = db.prepare(`
      INSERT INTO repos (name, root_path, indexed_at, file_count, url, added_at, external_id)
      VALUES (@name, @rootPath, @indexedAt, 0, @url, @addedAt, @externalId)
      ON CONFLICT(root_path) DO UPDATE SET
        name = COALESCE(@nameOverride, repos.name),
        indexed_at = excluded.indexed_at,
        url = COALESCE(excluded.url, repos.url),
        added_at = COALESCE(excluded.added_at, repos.added_at),
        external_id = COALESCE(excluded.external_id, repos.external_id)
    `);
    const selectRepoId = db.prepare("SELECT id FROM repos WHERE root_path = ?");
    const deleteSymbols = db.prepare(
      "DELETE FROM symbols WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)",
    );
    const deleteImports = db.prepare(`
      DELETE FROM imports
      WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)
         OR target_file_id IN (SELECT id FROM files WHERE repo_id = ?)
    `);
    const deleteFiles = db.prepare("DELETE FROM files WHERE repo_id = ?");
    const insertFile = db.prepare(`
      INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateRepo = db.prepare(
      "UPDATE repos SET file_count = ?, indexed_at = ? WHERE id = ?",
    );

    // Upsert the repo, clear its previous rows, and insert the current files as
    // one unit so a failure cannot leave a half-indexed repo behind.
    const writeIndex = db.transaction(() => {
      upsertRepo.run({
        name: repoName,
        rootPath,
        indexedAt,
        url: metadata.url ?? null,
        addedAt: metadata.addedAt ?? null,
        externalId: metadata.externalId ?? null,
        nameOverride: metadata.name ?? null,
      });
      const { id: repoId } = selectRepoId.get(rootPath);

      deleteSymbols.run(repoId);
      deleteImports.run(repoId, repoId);
      deleteFiles.run(repoId);

      for (const record of fileRecords) {
        insertFile.run(
          repoId,
          record.path,
          record.absPath,
          record.language,
          record.loc,
          record.rawContent,
          indexedAt,
        );
      }

      updateRepo.run(fileRecords.length, indexedAt, repoId);

      return { repoId, fileCount: fileRecords.length };
    });

    const result = writeIndex();

    mainWindow?.webContents?.send("index-progress", {
      completed,
      total,
      currentFile: null,
    });

    return result;
  }
}

module.exports = { IndexerService };
