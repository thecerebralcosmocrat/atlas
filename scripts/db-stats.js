// Dev utility: print the contents of the Atlas index database.
// Runs under Electron's Node (see the db:stats npm script) because
// better-sqlite3 is built for Electron's ABI.
//
// Usage: npm run db:stats [path/to/atlas.db]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

function defaultDbPath() {
  const appData =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));

  return path.join(appData, "projectatlas", "atlas-data", "atlas.db");
}

const dbPath = process.argv[2] || defaultDbPath();

if (!fs.existsSync(dbPath)) {
  console.log(`No database found at:\n  ${dbPath}`);
  console.log("Index a repository through the app first.");
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true });

// Tolerate a database that predates the repository metadata migration by only
// selecting the columns that actually exist.
const availableColumns = new Set(
  db
    .prepare("PRAGMA table_info(repos)")
    .all()
    .map((row) => row.name),
);
const selectedColumns = [
  "id",
  "external_id",
  "name",
  "url",
  "file_count",
  "indexed_at",
].filter((column) => availableColumns.has(column));
const repos = db
  .prepare(`SELECT ${selectedColumns.join(", ")} FROM repos ORDER BY id`)
  .all();
const fileCount = db.prepare("SELECT COUNT(*) AS n FROM files").get().n;

console.log(`Database: ${dbPath}`);
console.log(`Repos: ${repos.length}  Files: ${fileCount}`);
console.log("");

if (repos.length === 0) {
  console.log("(no repositories indexed yet)");
} else {
  // Plain-ASCII alignment instead of console.table(): the box-drawing glyphs it
  // emits render as mojibake in terminals that are not UTF-8.
  const cells = (repo) =>
    selectedColumns.map((column) => String(repo[column] ?? "-"));
  const widths = selectedColumns.map((column, index) =>
    Math.max(column.length, ...repos.map((repo) => cells(repo)[index].length)),
  );
  const formatRow = (values) =>
    values.map((value, index) => value.padEnd(widths[index])).join("  ");

  console.log(formatRow(selectedColumns));
  console.log(formatRow(widths.map((width) => "-".repeat(width))));

  for (const repo of repos) console.log(formatRow(cells(repo)));
}

db.close();
