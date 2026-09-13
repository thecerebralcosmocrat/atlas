const fs = require("fs/promises");
const path = require("path");
const { getDb } = require("../db/schema");
const { FileTraverser } = require("./FileTraverser");
const { extractFileSymbols } = require("./SymbolExtractor");
const { createImportResolver, toPosix } = require("./ImportResolver");

// Progress is a courtesy to the renderer, not part of the index. If the window
// is destroyed while a clone is being indexed, send() throws; letting that
// escape would make repositories:add delete the folder even though the index
// committed, leaving a repository row pointing at a path that no longer exists.
function notifyProgress(mainWindow, payload) {
  try {
    mainWindow?.webContents?.send("index-progress", payload);
  } catch {
    // The renderer is gone; the index itself is unaffected.
  }
}

class IndexerService {
  async indexRepo(repoPath, mainWindow, metadata = {}, options = {}) {
    const { timeoutMs } = options;
    // A deadline rather than Promise.race: the loop checks it between files and
    // aborts before the synchronous write transaction, so nothing is committed.
    const deadline = timeoutMs == null ? Infinity : Date.now() + timeoutMs;
    const files = await new FileTraverser().traverse(repoPath, { deadline });
    const total = files.length;
    const repoName = metadata.name ?? path.basename(repoPath);
    const rootPath = path.resolve(repoPath);
    const db = getDb();

    // Read file contents before the transaction: better-sqlite3 transactions
    // are synchronous, so all async I/O has to happen up front.
    const fileRecords = [];
    let completed = 0;

    notifyProgress(mainWindow, {
      completed: 0,
      total,
      currentFile: null,
    });

    for (const file of files) {
      if (Date.now() >= deadline) {
        throw new Error(`Indexing timed out after ${timeoutMs}ms.`);
      }

      try {
        const rawContent = await fs.readFile(file.absPath, "utf8");
        const language = file.extension.slice(1);
        // Extract while reading rather than inside the transaction: parsing is
        // synchronous CPU work, and better-sqlite3 transactions should stay
        // free of anything but the writes themselves.
        const { symbols, imports } = extractFileSymbols({
          language,
          rawContent,
        });

        fileRecords.push({
          path: file.path,
          absPath: file.absPath,
          language,
          loc: file.loc,
          rawContent,
          symbols,
          imports,
        });

        completed += 1;

        if (completed % 50 === 0) {
          notifyProgress(mainWindow, {
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
    const selectFileIds = db.prepare(
      "SELECT id, path FROM files WHERE repo_id = ?",
    );
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (file_id, name, kind, signature, line_start, line_end, is_exported)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertImport = db.prepare(`
      INSERT INTO imports (source_file_id, target_file_id, import_specifier, import_type, resolved_external)
      VALUES (?, ?, ?, ?, ?)
    `);
    // Resolution only needs the set of indexed paths. Building it once keeps
    // every import lookup a map hit instead of a scan.
    const importResolver = createImportResolver(
      fileRecords.map((record) => record.path),
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

      // File ids only exist after the inserts, so symbols and imports are
      // written in a second pass that maps each indexed path back to its row.
      const fileIdByPath = new Map(
        selectFileIds.all(repoId).map((row) => [toPosix(row.path), row.id]),
      );
      let symbolCount = 0;
      let importCount = 0;

      for (const record of fileRecords) {
        const fileId = fileIdByPath.get(toPosix(record.path));

        if (fileId === undefined) continue;

        for (const symbol of record.symbols) {
          insertSymbol.run(
            fileId,
            symbol.name,
            symbol.kind,
            symbol.signature,
            symbol.lineStart,
            symbol.lineEnd,
            symbol.isExported ? 1 : 0,
          );
          symbolCount += 1;
        }

        for (const imported of record.imports) {
          const targetPath = importResolver.resolve(
            record.path,
            imported.specifier,
          );
          const targetFileId =
            targetPath === null
              ? null
              : fileIdByPath.get(toPosix(targetPath)) ?? null;

          insertImport.run(
            fileId,
            targetFileId,
            imported.specifier,
            imported.type,
            targetFileId === null ? 1 : 0,
          );
          importCount += 1;
        }
      }

      updateRepo.run(fileRecords.length, indexedAt, repoId);

      return { repoId, fileCount: fileRecords.length, symbolCount, importCount };
    });

    // Last chance to abort: the file loop can overrun the deadline on its final
    // read, so re-check before the synchronous transaction commits anything.
    if (Date.now() >= deadline) {
      throw new Error(`Indexing timed out after ${timeoutMs}ms.`);
    }

    const result = writeIndex();

    notifyProgress(mainWindow, {
      completed,
      total,
      currentFile: null,
    });

    return result;
  }
}

module.exports = { IndexerService };
