const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { buildGraph, getRepositoryGraph } = require("../electron/query/graph");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-graphdb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function makeFixtureRepo(files) {
  const root = makeTempDir("atlas-graphrepo-");

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
const INSERT_SYMBOL = `INSERT INTO symbols (file_id, name, kind, signature, line_start, line_end, is_exported)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_IMPORT = `INSERT INTO imports (source_file_id, target_file_id, import_specifier, import_type, resolved_external)
  VALUES (?, ?, ?, ?, ?)`;

test("builds contains edges from files to their symbols", () => {
  const { nodes, edges } = buildGraph({
    files: [
      { id: 1, path: "src/a.js", language: "js" },
      { id: 2, path: "src/b.js", language: "js" },
    ],
    symbols: [
      {
        id: 10,
        file_id: 1,
        name: "alpha",
        kind: "function",
        line_start: 1,
        line_end: 3,
        is_exported: 1,
      },
      {
        id: 11,
        file_id: 1,
        name: "Beta",
        kind: "class",
        line_start: 5,
        line_end: 9,
        is_exported: 0,
      },
    ],
    imports: [],
  });

  const fileNodes = nodes.filter((node) => node.type === "file");
  assert.deepStrictEqual(
    fileNodes.map((node) => node.id),
    ["file:1", "file:2"],
  );
  assert.strictEqual(fileNodes[0].symbolCount, 2);
  assert.strictEqual(fileNodes[1].symbolCount, 0);

  const symbolNode = nodes.find((node) => node.id === "symbol:10");
  assert.strictEqual(symbolNode.type, "function");
  assert.strictEqual(symbolNode.label, "alpha");
  assert.strictEqual(symbolNode.path, "src/a.js");
  assert.strictEqual(symbolNode.isExported, true);

  assert.deepStrictEqual(
    edges
      .filter((edge) => edge.type === "contains")
      .map((edge) => [edge.source, edge.target]),
    [
      ["file:1", "symbol:10"],
      ["file:1", "symbol:11"],
    ],
  );
});

test("builds import edges and collapses unresolved targets into external nodes", () => {
  const { nodes, edges } = buildGraph({
    files: [
      { id: 1, path: "src/a.js", language: "js" },
      { id: 2, path: "src/b.js", language: "js" },
    ],
    symbols: [],
    imports: [
      { source_file_id: 1, target_file_id: 2, import_specifier: "./b", import_type: "import" },
      { source_file_id: 1, target_file_id: null, import_specifier: "react", import_type: "import" },
      { source_file_id: 1, target_file_id: 999, import_specifier: "./missing", import_type: "import" },
      { source_file_id: 1, target_file_id: null, import_specifier: "react", import_type: "import" },
    ],
  });

  const importEdges = edges.filter((edge) => edge.type === "imports");
  assert.strictEqual(importEdges.length, 3, "duplicate edges are dropped");
  assert.deepStrictEqual(
    importEdges.map((edge) => [edge.target, edge.external]),
    [
      ["file:2", false],
      ["external:react", true],
      ["external:./missing", true],
    ],
  );

  const externalIds = nodes
    .filter((node) => node.type === "external")
    .map((node) => node.id);
  assert.deepStrictEqual(externalIds, ["external:./missing", "external:react"]);
});

test("getRepositoryGraph reads symbols and imports for one repository", () => {
  const db = freshDb();
  const repoId = insertRepo(db, "atlas", "atlas-1");
  const fileA = db
    .prepare(INSERT_FILE)
    .run(repoId, "src/a.js", "C:/data/repos/atlas/src/a.js", "js", 3, "", Date.now())
    .lastInsertRowid;
  const fileB = db
    .prepare(INSERT_FILE)
    .run(repoId, "src/b.js", "C:/data/repos/atlas/src/b.js", "js", 1, "", Date.now())
    .lastInsertRowid;
  db.prepare(INSERT_SYMBOL).run(fileA, "alpha", "function", "function alpha()", 1, 3, 1);
  db.prepare(INSERT_IMPORT).run(fileA, fileB, "./b", "import", 0);
  db.prepare(INSERT_IMPORT).run(fileA, null, "react", "import", 1);

  const graph = getRepositoryGraph("atlas-1");

  assert.strictEqual(
    graph.nodes.filter((node) => node.type === "file").length,
    2,
  );
  // Symbol nodes carry their kind (function, class, ...) as `type`, so they are
  // identified by their id prefix rather than by a single type value.
  assert.deepStrictEqual(
    graph.nodes
      .filter((node) => node.id.startsWith("symbol:"))
      .map((node) => node.label),
    ["alpha"],
  );
  assert.deepStrictEqual(
    graph.edges.filter((edge) => edge.type === "imports").map((edge) => edge.target),
    [`file:${fileB}`, "external:react"],
  );

  // The renderer's external id and the numeric primary key both resolve.
  assert.deepStrictEqual(getRepositoryGraph(String(repoId)), graph);
});

test("an unknown repository yields an empty graph", () => {
  freshDb();

  assert.deepStrictEqual(getRepositoryGraph("nope"), { nodes: [], edges: [] });
  assert.deepStrictEqual(getRepositoryGraph(null), { nodes: [], edges: [] });
});

test("indexing a repository makes its graph queryable end to end", async () => {
  freshDb();
  const repo = makeFixtureRepo({
    "src/a.js": [
      'import { helper } from "./b";',
      "",
      "export function alpha() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "src/b.js": "export function helper() {\n  return 1;\n}\n",
  });

  const result = await new IndexerService().indexRepo(repo, {
    webContents: { send() {} },
  });
  const graph = getRepositoryGraph(result.repoId);

  assert.deepStrictEqual(
    graph.nodes
      .filter((node) => node.id.startsWith("symbol:"))
      .map((node) => node.label)
      .sort(),
    ["alpha", "helper"],
  );

  const importEdges = graph.edges.filter((edge) => edge.type === "imports");
  assert.strictEqual(importEdges.length, 1);
  // "./b" resolves to the indexed src/b.js, so the edge is internal.
  assert.strictEqual(importEdges[0].external, false);
  assert.match(importEdges[0].target, /^file:\d+$/);
});

test("does not include another repository's files or symbols", () => {
  const db = freshDb();
  const repoA = insertRepo(db, "a", "repo-a");
  const repoB = insertRepo(db, "b", "repo-b");
  const fileA = db
    .prepare(INSERT_FILE)
    .run(repoA, "src/a.js", "C:/data/repos/a/src/a.js", "js", 1, "", Date.now())
    .lastInsertRowid;
  db.prepare(INSERT_FILE).run(
    repoB,
    "src/b.js",
    "C:/data/repos/b/src/b.js",
    "js",
    1,
    "",
    Date.now(),
  );
  db.prepare(INSERT_SYMBOL).run(fileA, "orbitIndex", "function", "", 1, 1, 1);

  const graph = getRepositoryGraph("repo-a");

  assert.deepStrictEqual(
    graph.nodes.filter((node) => node.type === "file").map((node) => node.path),
    ["src/a.js"],
  );
  assert.deepStrictEqual(getRepositoryGraph("repo-b").nodes, [
    {
      id: `file:${db.prepare("SELECT id FROM files WHERE repo_id = ?").get(repoB).id}`,
      type: "file",
      label: "src/b.js",
      path: "src/b.js",
      language: "js",
      symbolCount: 0,
    },
  ]);
});
