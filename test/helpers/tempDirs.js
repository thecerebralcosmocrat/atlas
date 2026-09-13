const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { closeDatabase } = require("../../electron/db/schema");

const tempDirectories = [];

// Creates a uniquely named directory under the OS temp dir and remembers it so
// cleanupTempDirs can remove it once the test file finishes.
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(dir);
  return dir;
}

// Git writes its packfiles read-only, and Windows refuses to delete a
// read-only file. Clear the bit across the tree before removing it.
function makeWritable(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      makeWritable(entryPath);
    } else if (entry.isSymbolicLink()) {
      continue;
    } else {
      fs.chmodSync(entryPath, 0o666);
    }
  }

  fs.chmodSync(dir, 0o777);
}

// Releases the SQLite connection before deleting anything: Windows refuses to
// remove a file that SQLite still holds open. Each test file runs in its own
// process, so closing the singleton here cannot disturb another file's tests.
function cleanupTempDirs() {
  closeDatabase();

  for (const dir of tempDirectories) {
    try {
      makeWritable(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      // One undeletable directory must not strand all the ones after it.
      console.error(`Failed to remove temp directory ${dir}:`, error.message);
    }
  }

  tempDirectories.length = 0;
}

module.exports = { makeTempDir, cleanupTempDirs };
