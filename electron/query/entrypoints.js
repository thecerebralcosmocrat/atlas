// Finds where execution begins and ranks the modules worth reading first.
//
// `buildStartHere` is pure so the ordering can be tested without a database,
// mirroring query/graph.js. `getStartHere` is the DB-backed wrapper: it reads
// the indexed paths, a Python main-guard flag, and the clone's package.json,
// then reuses getRepositoryGraph for the fan-in counts.

const fs = require("node:fs");
const path = require("node:path");

const { getDb } = require("../db/schema");
const { SOURCE_FILES_ONLY } = require("../db/languages");
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
  "Program.cs",
];

const ENTRY_BASENAME_RANK = new Map(
  ENTRY_BASENAME_ORDER.map((name, index) => [name, index]),
);

const SCRIPT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

// A C/C++ program starts at `main`. Only translation units are checked:
// headers never define the program's entry point.
const C_SOURCE_EXTENSION = /\.(c|cc|cpp|cxx)$/i;
const C_MAIN_DEFINITION = /^[ \t]*(?:int|auto)\s+main\s*\(/m;

function hasCMainFunction(content) {
  return C_MAIN_DEFINITION.test(String(content ?? ""));
}

// C# starts at a static `Main`, or in `Program.cs` with top-level statements.
// A Unity project has no `Main`: the engine instantiates MonoBehaviour scripts
// from scenes and calls their lifecycle methods, so a script that derives from
// MonoBehaviour and defines one of those methods is where its code starts
// running. Editor-only scripts (under an `Editor` folder) never ship in a build.
const CSHARP_SOURCE_EXTENSION = /\.cs$/i;
const CSHARP_MAIN_DEFINITION =
  /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/;
const UNITY_BEHAVIOUR_CLASS =
  /\bclass\s+\w+\s*(?:<[^>{]*>)?\s*:\s*[^{;]*\b(?:MonoBehaviour|NetworkBehaviour)\b/;
const UNITY_LIFECYCLE_METHOD =
  /\b(?:void|IEnumerator)\s+(?:Awake|OnEnable|Start|Update)\s*\(/;
const UNITY_EDITOR_DIRECTORY = /(^|\/)Editor\//;

// Returns "main", "unity", or null for a C# file's content. Comments are
// dropped first so a commented-out `Main` does not count.
function csharpEntryKind(content) {
  const code = String(content ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "");

  if (CSHARP_MAIN_DEFINITION.test(code)) return "main";

  if (UNITY_BEHAVIOUR_CLASS.test(code) && UNITY_LIFECYCLE_METHOD.test(code)) {
    return "unity";
  }

  return null;
}

const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_LIMIT = 12;

// Test directories and file names are excluded from the reading path: a module
// imported only by its own test is not a good first read.
// Also directories named like `unit_tests` or `umd-test`, which C/C++ projects
// use for their test runners (each with its own main()).
const TEST_DIRECTORY =
  /(^|\/)(__tests__|tests?|specs?|[^/]*[-_]tests?)\//i;
// C# test classes are named `FooTests.cs` / `FooTest.cs`.
const CSHARP_TEST_FILENAME = /[A-Za-z0-9]Tests?\.cs$/;
const TEST_FILENAME = /(^|[.\-_])(test|spec)\.[a-z]+$/i;
const PYTHON_TEST_FILENAME = /(^|\/)test_[^/]*\.py$/i;

function isTestPath(filePath) {
  const posixPath = toPosix(filePath);

  return (
    TEST_DIRECTORY.test(posixPath) ||
    TEST_FILENAME.test(posixPath) ||
    PYTHON_TEST_FILENAME.test(posixPath) ||
    CSHARP_TEST_FILENAME.test(posixPath)
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
  if (name === "Program.cs") return "C# Program.cs";
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
  const cMainByPath = new Map();
  const csharpKindByPath = new Map();

  for (const file of files) {
    if (!file || file.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);

    if (!fileIdByPath.has(posixPath)) {
      fileIdByPath.set(posixPath, file.id ?? null);
      guardByPath.set(posixPath, Boolean(file.hasMainGuard));
      cMainByPath.set(posixPath, Boolean(file.hasCMain));
      csharpKindByPath.set(posixPath, file.csharpEntry ?? null);
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

  // A C/C++ source file that defines main() is an entry. Test runners also
  // define main(), so they are left out: they are not where the program starts.
  const cMainMatches = [...fileIdByPath.keys()]
    .filter(
      (candidate) =>
        cMainByPath.get(candidate) &&
        C_SOURCE_EXTENSION.test(candidate) &&
        !isTestPath(candidate),
    )
    .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));

  for (const candidate of cMainMatches) {
    add(candidate, "C/C++ main()");
  }

  // A C# `Main` method, then Unity scripts that the engine runs from a scene.
  // Test and editor-only files are left out for the same reason as C tests.
  const csharpMatches = [...fileIdByPath.keys()]
    .filter(
      (candidate) =>
        csharpKindByPath.get(candidate) &&
        CSHARP_SOURCE_EXTENSION.test(candidate) &&
        !isTestPath(candidate) &&
        !UNITY_EDITOR_DIRECTORY.test(candidate),
    )
    .sort(
      (left, right) =>
        (csharpKindByPath.get(left) === "main" ? 0 : 1) -
          (csharpKindByPath.get(right) === "main" ? 0 : 1) ||
        depth(left) - depth(right) ||
        left.localeCompare(right),
    );

  for (const candidate of csharpMatches) {
    add(
      candidate,
      csharpKindByPath.get(candidate) === "main"
        ? "C# Main()"
        : "Unity MonoBehaviour",
    );
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

// Entry points that only show up in a file's content: C/C++ `main()` and C#
// `Main` / Unity scripts. Only candidate files mentioning the marker word have
// their content read, so a large repository does not load every file just to
// look for entries. Sets `hasCMain` and `csharpEntry` on each row.
function markContentEntries(db, repoId, files) {
  const cMainIds = new Set(
    db
      .prepare(
        `SELECT id, raw_content FROM files
          WHERE repo_id = ?
            AND instr(raw_content, 'main') > 0
            AND (lower(path) LIKE '%.c' OR lower(path) LIKE '%.cc'
                 OR lower(path) LIKE '%.cpp' OR lower(path) LIKE '%.cxx')`,
      )
      .all(repoId)
      .filter((row) => hasCMainFunction(row.raw_content))
      .map((row) => row.id),
  );
  const csharpKindById = new Map(
    db
      .prepare(
        `SELECT id, raw_content FROM files
          WHERE repo_id = ?
            AND lower(path) LIKE '%.cs'
            AND (instr(raw_content, 'Main') > 0
                 OR instr(raw_content, 'MonoBehaviour') > 0
                 OR instr(raw_content, 'NetworkBehaviour') > 0)`,
      )
      .all(repoId)
      .map((row) => [row.id, csharpEntryKind(row.raw_content)])
      .filter(([, kind]) => kind !== null),
  );

  for (const file of files) {
    file.hasCMain = cMainIds.has(file.id);
    file.csharpEntry = csharpKindById.get(file.id) ?? null;
  }

  return files;
}

function getStartHere(repositoryId) {
  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return { entries: [], readingPath: [] };

  const db = getDb();
  const files = db
    .prepare(
      `SELECT id, path, instr(raw_content, '__main__') > 0 AS hasMainGuard
         FROM files
        WHERE repo_id = ? AND ${SOURCE_FILES_ONLY}`,
    )
    .all(repoId);
  const repo = db
    .prepare("SELECT root_path FROM repos WHERE id = ?")
    .get(repoId);

  markContentEntries(db, repoId, files);

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
  csharpEntryKind,
  hasCMainFunction,
  isTestPath,
  markContentEntries,
  readPackageJson,
};
