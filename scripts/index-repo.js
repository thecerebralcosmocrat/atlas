// Dev utility: run the indexer against a local folder and write the result
// into the Atlas SQLite database. This mirrors what the app will do once
// indexing is wired into the add flow (increment I3).
//
// Runs under Electron's Node (see the index npm script) because
// better-sqlite3 is built for Electron's ABI.
//
// Usage: npm run index -- <repo-path> [--db=<path>]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");

function defaultDbPath() {
  const appData =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));

  return path.join(appData, "projectatlas", "atlas-data", "atlas.db");
}

const args = process.argv.slice(2);
const dbFlag = args.find((arg) => arg.startsWith("--db="));
const repoArg = args.find((arg) => !arg.startsWith("--"));

if (!repoArg) {
  console.error("Usage: npm run index -- <repo-path> [--db=<path>]");
  process.exit(1);
}

const repoPath = path.resolve(repoArg);
const dbPath = dbFlag
  ? path.resolve(dbFlag.slice("--db=".length))
  : defaultDbPath();

if (!fs.existsSync(repoPath)) {
  console.error(`Repository path not found: ${repoPath}`);
  process.exit(1);
}

initializeDatabase(dbPath);

const progressWindow = {
  webContents: {
    send: (channel, payload) => {
      if (channel === "index-progress") {
        console.log(`  ${payload.completed}/${payload.total}`);
      }
    },
  },
};

new IndexerService()
  .indexRepo(repoPath, progressWindow)
  .then((result) => {
    console.log(
      `Indexed ${result.fileCount} file(s) (repo id ${result.repoId}).`,
    );
    console.log(`Database: ${dbPath}`);
    console.log("Run `npm run db:stats` to inspect it.");
  })
  .catch((error) => {
    console.error(`Indexing failed: ${error.message}`);
    process.exit(1);
  });
