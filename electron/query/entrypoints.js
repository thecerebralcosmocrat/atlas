// Finds where execution begins and ranks the modules worth reading first.
//
// `buildStartHere` is pure so the ordering can be tested without a database,
// mirroring query/graph.js. `getStartHere` is the DB-backed wrapper: it reads
// the indexed paths, a Python main-guard flag, and the clone's package.json,
// then reuses getRepositoryGraph for the fan-in counts.

const fs = require("node:fs");
const path = require("node:path");

const { getDb } = require("../db/schema");
const { toPosix } = require("../indexer/ImportResolver");
const { findRepoPrimaryKey, getRepositoryGraph } = require("./graph");

// Basenames that usually mean "execution starts here". Ranked so that index
// files beat main/app/server/cli when a repository has several of them.
const ENTRY_BASENAME_ORDER = [
  "index.js",
  "index.jsx",
  "index.ts",
  "index.tsx",
  "main.js",
  "main.jsx",
  "main.ts",
  "main.tsx",
  "app.js",
  "app.jsx",
  "app.ts",
  "app.tsx",
  "server.js",
  "server.ts",
  "cli.js",
  "cli.ts",
  "__main__.py",
  "main.py",
  "app.py",
];

const ENTRY_BASENAME_RANK = new Map(
  ENTRY_BASENAME_ORDER.map((name, index) => [name, index]),
);

const SCRIPT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_LIMIT = 12;

// Test directories and file names are excluded from the reading path: a module
// imported only by its own test is not a good first read.
const TEST_DIRECTORY = /(^|\/)(__tests__|tests?|specs?)\//;
const TEST_FILENAME = /(^|[.\-_])(test|spec)\.[a-z]+$/i;
const PYTHON_TEST_FILENAME = /(^|\/)test_[^/]*\.py$/i;

function isTestPath(filePath) {
  const posixPath = toPosix(filePath);

  return (
    TEST_DIRECTORY.test(posixPath) ||
    TEST_FILENAME.test(posixPath) ||
    PYTHON_TEST_FILENAME.test(posixPath)
  );
}

function basename(filePath) {
  const posixPath = toPosix(filePath);
  return posixPath.slice(posixPath.lastIndexOf("/") + 1);
}

function depth(filePath) {
  return toPosix(filePath).split("/").length - 1;
}

function parsePackageJson(packageJson) {
  if (!packageJson) return null;
  if (typeof packageJson === "object") return packageJson;

  try {
    const parsed = JSON.parse(packageJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// A package.json path is written the way Node resolves it: no extension, or a
// directory that means its index. Only paths that are actually indexed count,
// so a `main` pointing at a skipped `dist/` resolves to nothing.
function resolveIndexedPath(candidate, hasPath) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;

  const cleaned = toPosix(candidate).replace(/^\.\//, "").replace(/^\/+/, "");

  if (cleaned.length === 0 || cleaned.startsWith("..")) return null;

  const attempts = [cleaned];

  if (!/\.[a-z0-9]+$/i.test(cleaned)) {
    for (const extension of [...SCRIPT_EXTENSIONS, ".py"]) {
      attempts.push(`${cleaned}${extension}`);
    }

    for (const extension of SCRIPT_EXTENSIONS) {
      attempts.push(`${cleaned}/index${extension}`);
    }

    attempts.push(`${cleaned}/__init__.py`);
  }

  return attempts.find((attempt) => hasPath(attempt)) ?? null;
}

function entryReason(filePath) {
  const name = basename(filePath);

  if (name.startsWith("index.")) return "index file";
  if (name === "__main__.py") return "Python __main__ module";
  if (name.endsWith(".py")) return "Python entry module";
  return "entry module";
}

function detectEntryPoints({
  files = [],
  packageJson = "",
  maxEntries = DEFAULT_MAX_ENTRIES,
}) {
  const fileIdByPath = new Map();
  const guardByPath = new Map();

  for (const file of files) {
    if (!file || file.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);

    if (!fileIdByPath.has(posixPath)) {
      fileIdByPath.set(posixPath, file.id ?? null);
      guardByPath.set(posixPath, Boolean(file.hasMainGuard));
    }
  }

  const hasPath = (candidate) => fileIdByPath.has(candidate);
  const found = [];
  const seen = new Set();

  function add(candidate, reason) {
    const posixPath = toPosix(candidate);

    if (seen.has(posixPath) || !hasPath(posixPath)) return;

    seen.add(posixPath);
    found.push({ fileId: fileIdByPath.get(posixPath) ?? null, path: posixPath, reason });
  }

  const parsed = parsePackageJson(packageJson);

  if (parsed) {
    const resolvedMain = resolveIndexedPath(parsed.main, hasPath);
    if (resolvedMain) add(resolvedMain, "package.json main");

    const bin = parsed.bin;
    const binPaths =
      typeof bin === "string"
        ? [bin]
        : bin && typeof bin === "object"
          ? Object.keys(bin)
              .sort()
              .map((key) => bin[key])
          : [];

    for (const candidate of binPaths) {
      const resolved = resolveIndexedPath(candidate, hasPath);
      if (resolved) add(resolved, "package.json bin");
    }
  }

  // Basename matches are ordered shallowest-first, then by the basename
  // priority, so `src/index.js` outranks `packages/a/main.js`.
  const basenameMatches = [...fileIdByPath.keys()]
    .filter((candidate) => ENTRY_BASENAME_RANK.has(basename(candidate)))
    .sort(
      (left, right) =>
        depth(left) - depth(right) ||
        ENTRY_BASENAME_RANK.get(basename(left)) -
          ENTRY_BASENAME_RANK.get(basename(right)) ||
        left.localeCompare(right),
    );

  for (const candidate of basenameMatches) {
    add(candidate, entryReason(candidate));
  }

  // A Python module with an explicit main guard is an entry even when its name
  // is not one of the conventional ones above.
  const guardMatches = [...fileIdByPath.keys()]
    .filter((candidate) => guardByPath.get(candidate) && candidate.endsWith(".py"))
    .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));

  for (const candidate of guardMatches) {
    add(candidate, "Python __main__ guard");
  }

  return found.slice(0, Math.max(0, maxEntries));
}

// Counts, per file path, how many distinct files import it. External packages
// and unresolved imports do not contribute: fan-in is about internal coupling.
function buildFanIn(graph) {
  const pathByNodeId = new Map();

  for (const node of graph.nodes ?? []) {
    if (node.type === "file") pathByNodeId.set(node.id, toPosix(node.path));
  }

  const importersByTarget = new Map();

  for (const edge of graph.edges ?? []) {
    if (edge.type !== "imports" || edge.external) continue;
    if (!pathByNodeId.has(edge.target)) continue;

    // A test importing a module is not evidence the module is core, so test
    // importers do not count toward fan-in.
    if (isTestPath(pathByNodeId.get(edge.source))) continue;

    const importers = importersByTarget.get(edge.target) ?? new Set();

    importers.add(edge.source);
    importersByTarget.set(edge.target, importers);
  }

  const fanInByPath = new Map();

  for (const [nodeId, importers] of importersByTarget) {
    fanInByPath.set(pathByNodeId.get(nodeId), importers.size);
  }

  return fanInByPath;
}

function buildStartHere({
  graph = { nodes: [], edges: [] },
  files = [],
  packageJson = "",
  options = {},
}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const entries = detectEntryPoints({ files, packageJson, maxEntries });
  const fanInByPath = buildFanIn(graph);

  const fileIdByPath = new Map();

  for (const file of files) {
    if (!file || file.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);

    if (!fileIdByPath.has(posixPath)) fileIdByPath.set(posixPath, file.id ?? null);
  }

  const entryPaths = new Set(entries.map((entry) => entry.path));
  const entryItems = entries.map((entry) => ({
    fileId: entry.fileId,
    path: entry.path,
    reason: entry.reason,
    isEntry: true,
    fanIn: fanInByPath.get(entry.path) ?? 0,
  }));

  const rankedItems = [...fanInByPath.entries()]
    .filter(
      ([filePath, fanIn]) =>
        fanIn > 0 && !entryPaths.has(filePath) && !isTestPath(filePath),
    )
    .sort(
      ([leftPath, leftFanIn], [rightPath, rightFanIn]) =>
        rightFanIn - leftFanIn || leftPath.localeCompare(rightPath),
    )
    .slice(0, Math.max(0, limit - entryItems.length))
    .map(([filePath, fanIn]) => ({
      fileId: fileIdByPath.get(filePath) ?? null,
      path: filePath,
      reason: null,
      isEntry: false,
      fanIn,
    }));

  return { entries, readingPath: [...entryItems, ...rankedItems] };
}

function readPackageJson(rootPath) {
  if (!rootPath) return "";

  try {
    return fs.readFileSync(path.join(rootPath, "package.json"), "utf8");
  } catch {
    return "";
  }
}

function getStartHere(repositoryId) {
  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return { entries: [], readingPath: [] };

  const db = getDb();
  const files = db
    .prepare(
      `SELECT id, path, instr(raw_content, '__main__') > 0 AS hasMainGuard
         FROM files
        WHERE repo_id = ?`,
    )
    .all(repoId);
  const repo = db
    .prepare("SELECT root_path FROM repos WHERE id = ?")
    .get(repoId);

  return buildStartHere({
    graph: getRepositoryGraph(repositoryId),
    files,
    packageJson: readPackageJson(repo?.root_path),
  });
}

module.exports = {
  buildStartHere,
  detectEntryPoints,
  getStartHere,
  isTestPath,
};
