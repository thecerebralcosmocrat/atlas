const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { buildGraph } = require("../electron/query/graph");
const {
  buildStartHere,
  detectEntryPoints,
  getStartHere,
  isTestPath,
} = require("../electron/query/entrypoints");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-startdb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function makeFixtureRepo(files) {
  const root = makeTempDir("atlas-startrepo-");

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function insertRepo(db, name, externalId) {
  return db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run(name, `C:/data/repos/${name}`, externalId).lastInsertRowid;
}

const INSERT_FILE = `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

test("detects package.json main and bin entry points", () => {
  const files = [
    { id: 1, path: "src/server.js" },
    { id: 2, path: "bin/cli.js" },
    { id: 3, path: "src/unrelated.js" },
  ];
  const entries = detectEntryPoints({
    files,
    packageJson: { main: "./src/server.js", bin: { atlas: "./bin/cli.js" } },
  });

  assert.deepStrictEqual(
    entries.map((entry) => [entry.path, entry.reason, entry.fileId]),
    [
      ["src/server.js", "package.json main", 1],
      ["bin/cli.js", "package.json bin", 2],
    ],
  );
});

test("resolves an extensionless package.json main to an indexed index file", () => {
  const files = [
    { id: 1, path: "src/index.ts" },
    { id: 2, path: "src/other.js" },
  ];

  assert.deepStrictEqual(
    detectEntryPoints({ files, packageJson: '{"main":"src"}' }).map(
      (entry) => entry.path,
    ),
    ["src/index.ts"],
  );
});

test("ignores a package.json main that is not indexed", () => {
  const files = [{ id: 1, path: "src/index.js" }];
  const entries = detectEntryPoints({
    files,
    packageJson: { main: "dist/bundle.js" },
  });

  assert.deepStrictEqual(entries.map((entry) => entry.path), ["src/index.js"]);
  assert.strictEqual(entries[0].reason, "index file");
});

test("malformed package.json falls back to basename entry points", () => {
  const files = [{ id: 1, path: "index.js" }];

  assert.deepStrictEqual(
    detectEntryPoints({ files, packageJson: "{ not json" }).map(
      (entry) => entry.path,
    ),
    ["index.js"],
  );
});

test("orders index files shallowest-first", () => {
  const files = [
    { id: 1, path: "packages/a/index.js" },
    { id: 2, path: "index.js" },
    { id: 3, path: "src/index.js" },
  ];

  assert.deepStrictEqual(
    detectEntryPoints({ files }).map((entry) => entry.path),
    ["index.js", "src/index.js", "packages/a/index.js"],
  );
});

test("detects a Python module with a __main__ guard", () => {
  const files = [
    { id: 1, path: "scripts/run.py", hasMainGuard: true },
    { id: 2, path: "lib/util.py" },
  ];

  assert.deepStrictEqual(
    detectEntryPoints({ files }).map((entry) => [entry.path, entry.reason]),
    [["scripts/run.py", "Python __main__ guard"]],
  );
});

test("caps the number of entry points", () => {
  const files = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    path: `p${index}/index.js`,
  }));

  assert.strictEqual(detectEntryPoints({ files, maxEntries: 3 }).length, 3);
});

test("recognizes test files and directories", () => {
  for (const filePath of [
    "test/a.js",
    "tests/a.js",
    "src/__tests__/a.js",
    "src/a.test.js",
    "src/a.spec.ts",
    "test_a.py",
    "spec/b.js",
  ]) {
    assert.ok(isTestPath(filePath), filePath);
  }

  for (const filePath of [
    "src/contest/a.js",
    "src/latest.js",
    "src/a.js",
    "app/main.py",
  ]) {
    assert.ok(!isTestPath(filePath), filePath);
  }
});

test("ranks non-test modules by fan-in after the entry points", () => {
  const fileRows = [
    { id: 1, path: "index.js" },
    { id: 2, path: "src/util.js" },
    { id: 3, path: "src/other.js" },
    { id: 4, path: "test/util.test.js" },
  ];
  const graph = buildGraph({
    files: fileRows.map((file) => ({ ...file, language: "js" })),
    symbols: [],
    imports: [
      { source_file_id: 1, target_file_id: 2, import_specifier: "./src/util", import_type: "import" },
      { source_file_id: 3, target_file_id: 2, import_specifier: "./util", import_type: "import" },
      { source_file_id: 4, target_file_id: 2, import_specifier: "../src/util", import_type: "import" },
    ],
  });

  const { readingPath } = buildStartHere({ graph, files: fileRows });

  assert.deepStrictEqual(
    readingPath.map((item) => [item.path, item.isEntry, item.fanIn]),
    [
      ["index.js", true, 0],
      ["src/util.js", false, 2],
    ],
  );
});

test("returns nothing to read when there are no entries or imports", () => {
  const graph = buildGraph({
    files: [{ id: 1, path: "src/a.js", language: "js" }],
    symbols: [],
    imports: [],
  });

  assert.deepStrictEqual(
    buildStartHere({ graph, files: [{ id: 1, path: "src/a.js" }] }),
    { entries: [], readingPath: [] },
  );
});

test("caps the reading path after the entry points", () => {
  const fileRows = [
    { id: 1, path: "index.js" },
    { id: 2, path: "src/a.js" },
    { id: 3, path: "src/b.js" },
    { id: 4, path: "src/c.js" },
  ];
  const graph = buildGraph({
    files: fileRows.map((file) => ({ ...file, language: "js" })),
    symbols: [],
    imports: [
      { source_file_id: 1, target_file_id: 2, import_specifier: "./a", import_type: "import" },
      { source_file_id: 1, target_file_id: 3, import_specifier: "./b", import_type: "import" },
      { source_file_id: 1, target_file_id: 4, import_specifier: "./c", import_type: "import" },
    ],
  });

  const { readingPath } = buildStartHere({
    graph,
    files: fileRows,
    options: { limit: 2 },
  });

  assert.deepStrictEqual(
    readingPath.map((item) => item.path),
    ["index.js", "src/a.js"],
  );
});

test("getStartHere returns nothing for an unknown repository", () => {
  freshDb();

  assert.deepStrictEqual(getStartHere("nope"), { entries: [], readingPath: [] });
});

test("indexing a repository yields entry points and a reading path", async () => {
  freshDb();
  const repo = makeFixtureRepo({
    "package.json": JSON.stringify({ main: "src/index.js" }),
    "src/index.js": [
      'import { helper } from "./util";',
      "",
      "export function start() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "src/util.js": "export function helper() {\n  return 1;\n}\n",
    "src/other.js": "export const unused = 1;\n",
  });

  const { repoId } = await new IndexerService().indexRepo(repo, {
    webContents: { send() {} },
  });
  const startHere = getStartHere(repoId);

  assert.deepStrictEqual(
    startHere.readingPath.map((item) => [item.path, item.isEntry, item.fanIn]),
    [
      ["src/index.js", true, 0],
      ["src/util.js", false, 1],
    ],
  );
  assert.strictEqual(startHere.entries[0].reason, "package.json main");
});

test("detects a Python __main__ guard end to end", async () => {
  freshDb();
  const repo = makeFixtureRepo({
    "app/run.py": ['if __name__ == "__main__":', '    print("hi")', ""].join("\n"),
    "app/core.py": "def helper():\n    return 1\n",
  });

  const { repoId } = await new IndexerService().indexRepo(repo, {
    webContents: { send() {} },
  });
  const { entries } = getStartHere(repoId);

  assert.deepStrictEqual(
    entries.map((entry) => [entry.path, entry.reason]),
    [["app/run.py", "Python __main__ guard"]],
  );
});

test("does not mix another repository's entry points into the reading path", () => {
  const db = freshDb();
  const repoA = insertRepo(db, "a", "repo-a");
  const repoB = insertRepo(db, "b", "repo-b");
  const insert = db.prepare(INSERT_FILE);
  const now = Date.now();

  insert.run(repoA, "index.js", "C:/data/repos/a/index.js", "js", 1, "", now);
  insert.run(repoB, "index.js", "C:/data/repos/b/index.js", "js", 1, "", now);

  assert.deepStrictEqual(
    getStartHere("repo-a").readingPath.map((item) => [item.path, item.fanIn]),
    [["index.js", 0]],
  );
});
