const fs = require("fs/promises");
const path = require("path");

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "__pycache__",
  "coverage",
  ".cache",
  "vendor",
]);

const SKIP_FILE_SUFFIXES = [
  ".lock",
  ".min.js",
  ".bundle.js",
  ".map",
  ".png",
  ".jpg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
];

const ALLOWED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
]);

const MAX_FILE_SIZE_BYTES = 500 * 1024;

class FileTraverser {
  async traverse(repoPath) {
    const results = [];
    const resolvedRepoPath = path.resolve(repoPath);

    await this._walk(resolvedRepoPath, resolvedRepoPath, results);

    return results;
  }

  async _walk(currentDir, repoPath, results) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }

        await this._walk(absPath, repoPath, results);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (this._shouldSkipFile(entry.name)) {
        continue;
      }

      const extension = path.extname(entry.name);

      if (!ALLOWED_EXTENSIONS.has(extension)) {
        continue;
      }

      const stat = await fs.stat(absPath);

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      const content = await fs.readFile(absPath, "utf8");
      const loc = content.split("\n").filter((line) => line.length > 0).length;

      results.push({
        path: path.relative(repoPath, absPath),
        absPath,
        extension,
        loc,
      });
    }
  }

  _shouldSkipFile(fileName) {
    const lowerName = fileName.toLowerCase();

    return SKIP_FILE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
  }
}

module.exports = { FileTraverser };
