const fs = require("fs/promises");
const path = require("path");
const { getDb } = require("../db/schema");
const { FileTraverser } = require("./FileTraverser");

class IndexerService {
  async indexRepo(repoPath, mainWindow) {
    const files = await new FileTraverser().traverse(repoPath);
    const total = files.length;
    const repoName = path.basename(repoPath);
    const rootPath = path.resolve(repoPath);
    const db = getDb();

    const insertRepo = db.prepare(`
      INSERT INTO repos (name, root_path, indexed_at, file_count)
      VALUES (?, ?, ?, 0)
    `);
    const repoResult = insertRepo.run(repoName, rootPath, Date.now());
    const repoId = repoResult.lastInsertRowid;

    const fileRecords = [];
    let completed = 0;

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

    const insertFile = db.prepare(`
      INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const indexedAt = Date.now();
    const insertFiles = db.transaction((records) => {
      for (const record of records) {
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
    });

    insertFiles(fileRecords);

    db.prepare(`
      UPDATE repos SET file_count = ?, indexed_at = ? WHERE id = ?
    `).run(fileRecords.length, indexedAt, repoId);

    return { repoId, fileCount: fileRecords.length };
  }
}

module.exports = { IndexerService };
