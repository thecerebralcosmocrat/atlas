const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { buildGraph } = require("../electron/query/graph");
const {
  answerGraphQuestion,
  answerRepositoryGraphQuestion,
  detectGraphIntent,
  fileImpact,
  findSymbolDefinitions,
  findSymbolReferences,
  findUnreachableFiles,
  getImpact,
  resolveGraphTarget,
} = require("../electron/query/impact");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-impactdb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function makeFixtureRepo(files) {
  const root = makeTempDir("atlas-impactrepo-");

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function jsGraph(files, imports) {
  return buildGraph({
    files: files.map((file) => ({ ...file, language: "js" })),
    symbols: [],
    imports,
  });
}

const CHAIN_FILES = [
  { id: 1, path: "src/app.js" },
  { id: 2, path: "src/util.js" },
  { id: 3, path: "src/mid.js" },
  { id: 4, path: "src/leaf.js" },
];

const CHAIN_IMPORTS = [
  { source_file_id: 1, target_file_id: 2, import_specifier: "./util", import_type: "import" },
  { source_file_id: 3, target_file_id: 2, import_specifier: "./util", import_type: "require" },
  { source_file_id: 4, target_file_id: 3, import_specifier: "./mid", import_type: "import" },
];

test("reports direct importers and the transitive blast radius", () => {
  const graph = jsGraph(CHAIN_FILES, CHAIN_IMPORTS);
  const impact = fileImpact({ graph, path: "src/util.js" });

  assert.strictEqual(impact.fileId, 2);
  assert.deepStrictEqual(
    impact.importers.map((importer) => [importer.path, importer.importType]),
    [
      ["src/app.js", "import"],
      ["src/mid.js", "require"],
    ],
  );
  assert.deepStrictEqual(
    impact.dependents.map((dependent) => [dependent.path, dependent.distance]),
    [
      ["src/app.js", 1],
      ["src/mid.js", 1],
      ["src/leaf.js", 2],
    ],
  );
});

test("returns null for a path that is not in the graph", () => {
  const graph = jsGraph(CHAIN_FILES, CHAIN_IMPORTS);

  assert.strictEqual(fileImpact({ graph, path: "src/missing.js" }), null);
  assert.strictEqual(fileImpact({ graph, path: "" }), null);
});

test("ignores external and unresolved imports", () => {
  const graph = jsGraph(
    [{ id: 1, path: "src/a.js" }],
    [
      { source_file_id: 1, target_file_id: null, import_specifier: "react", import_type: "import" },
      { source_file_id: 1, target_file_id: 99, import_specifier: "./gone", import_type: "import" },
    ],
  );

  assert.deepStrictEqual(fileImpact({ graph, path: "src/a.js" }).importers, []);
});

test("terminates on an import cycle and does not count the file as its own dependent", () => {
  const graph = jsGraph(
    [
      { id: 1, path: "a.js" },
      { id: 2, path: "b.js" },
    ],
    [
      { source_file_id: 1, target_file_id: 2, import_specifier: "./b", import_type: "import" },
      { source_file_id: 2, target_file_id: 1, import_specifier: "./a", import_type: "import" },
    ],
  );

  const impact = fileImpact({ graph, path: "a.js" });

  assert.deepStrictEqual(impact.dependents, [{ path: "b.js", distance: 1 }]);
});

test("counts a self-import as an importer", () => {
  const graph = jsGraph(
    [{ id: 1, path: "a.js" }],
    [{ source_file_id: 1, target_file_id: 1, import_specifier: "./a", import_type: "import" }],
  );

  const impact = fileImpact({ graph, path: "a.js" });

  assert.deepStrictEqual(impact.importers.map((importer) => importer.path), ["a.js"]);
  assert.deepStrictEqual(impact.dependents, []);
});

test("finds files no entry point can reach, ignoring tests", () => {
  const graph = jsGraph(
    [
      { id: 1, path: "index.js" },
      { id: 2, path: "src/a.js" },
      { id: 3, path: "src/orphan.js" },
      { id: 4, path: "test/a.test.js" },
    ],
    [{ source_file_id: 1, target_file_id: 2, import_specifier: "./src/a", import_type: "import" }],
  );

  assert.deepStrictEqual(
    findUnreachableFiles({ graph, entryPaths: ["index.js"] }),
    ["src/orphan.js"],
  );
});

test("reports nothing as unreachable without an entry point to start from", () => {
  const graph = jsGraph([{ id: 1, path: "src/a.js" }], []);

  assert.deepStrictEqual(findUnreachableFiles({ graph, entryPaths: [] }), []);
});

test("finds symbol definitions by exact name", () => {
  const definitions = findSymbolDefinitions({
    symbols: [
      {
        id: 1,
        file_id: 2,
        name: "formatDate",
        kind: "function",
        line_start: 12,
        line_end: 18,
        is_exported: 1,
        path: "src/date.js",
      },
      {
        id: 2,
        file_id: 2,
        name: "formatDateTime",
        kind: "function",
        line_start: 20,
        line_end: 24,
        is_exported: 0,
        path: "src/date.js",
      },
    ],
    name: "FORMATDATE",
  });

  assert.deepStrictEqual(definitions, [
    {
      name: "formatDate",
      kind: "function",
      fileId: 2,
      path: "src/date.js",
      lineStart: 12,
      lineEnd: 18,
      isExported: true,
    },
  ]);
});

test("finds word-boundary references but skips the definition's own lines", () => {
  const definitions = [
    { path: "src/date.js", lineStart: 1, lineEnd: 3 },
  ];
  const references = findSymbolReferences({
    contents: [
      {
        path: "src/date.js",
        raw_content: "export function formatDate() {\n  return 1;\n}\n",
      },
      {
        path: "src/app.js",
        raw_content:
          "import { formatDate } from './date';\nformatDate();\nreformatDate();\n",
      },
    ],
    name: "formatDate",
    definitions,
  });

  assert.deepStrictEqual(references, [{ path: "src/app.js", lines: [1, 2] }]);
});

test("resolves and references symbols whose name starts with $", () => {
  const files = [{ id: 1, path: "src/store.js" }];
  const symbols = [
    {
      id: 1,
      file_id: 1,
      name: "$store",
      kind: "variable",
      line_start: 1,
      line_end: 1,
      is_exported: 1,
      path: "src/store.js",
    },
  ];

  assert.deepStrictEqual(
    resolveGraphTarget({ question: "where is $store used", files, symbols }),
    { kind: "symbol", name: "$store" },
  );

  assert.deepStrictEqual(
    findSymbolReferences({
      contents: [
        { path: "src/app.js", raw_content: "$store.get();\nmy$store.get();\n" },
      ],
      name: "$store",
      definitions: [{ path: "src/store.js", lineStart: 1, lineEnd: 1 }],
    }),
    [{ path: "src/app.js", lines: [1] }],
  );
});

test("classifies impact, symbol, and unreachability questions", () => {
  assert.strictEqual(detectGraphIntent("what imports src/util.js?"), "file");
  assert.strictEqual(detectGraphIntent("what depends on the config module"), "file");
  assert.strictEqual(detectGraphIntent("who uses formatDate"), "symbol");
  assert.strictEqual(detectGraphIntent("where is helper defined"), "symbol");
  assert.strictEqual(detectGraphIntent("which files are unused?"), "unreachable");
  assert.strictEqual(detectGraphIntent("how do I run this?"), null);
  assert.strictEqual(detectGraphIntent("what is the entry point?"), null);
});

test("resolves a target preferring a full path, then a basename, then a symbol", () => {
  const files = [{ id: 1, path: "src/util.js" }];
  const symbols = [{ name: "util" }];

  assert.deepStrictEqual(
    resolveGraphTarget({ question: "who imports src/util.js", files, symbols }),
    { kind: "file", path: "src/util.js" },
  );
  assert.deepStrictEqual(
    resolveGraphTarget({ question: "who imports util.js", files, symbols }),
    { kind: "file", path: "src/util.js" },
  );
  assert.deepStrictEqual(
    resolveGraphTarget({
      question: "where is formatDate used",
      files: [{ id: 1, path: "src/app.js" }],
      symbols: [{ name: "formatDate" }],
    }),
    { kind: "symbol", name: "formatDate" },
  );
  assert.strictEqual(
    resolveGraphTarget({ question: "how do I run this", files, symbols }),
    null,
  );
});

test("answers a file impact question from the graph", () => {
  const graph = jsGraph(CHAIN_FILES, CHAIN_IMPORTS);
  const answer = answerGraphQuestion({
    question: "what imports src/util.js?",
    graph,
    files: CHAIN_FILES,
    symbols: [],
  });

  assert.match(answer, /`src\/util\.js` is imported directly by 2 files/);
  assert.match(answer, /`src\/app\.js` \(import\)/);
  assert.match(answer, /can affect 3 files in total/);
  assert.match(answer, /`src\/leaf\.js` \(2 hops\)/);
});

test("answers a symbol usage question from definitions and references", () => {
  const graph = jsGraph([{ id: 1, path: "src/date.js" }], []);
  const answer = answerGraphQuestion({
    question: "where is formatDate used",
    graph,
    files: [{ id: 1, path: "src/date.js" }],
    symbols: [
      {
        id: 1,
        file_id: 1,
        name: "formatDate",
        kind: "function",
        line_start: 1,
        line_end: 3,
        is_exported: 1,
        path: "src/date.js",
      },
    ],
    contents: [
      {
        path: "src/date.js",
        raw_content: "export function formatDate() {\n  return 1;\n}\nformatDate();\n",
      },
    ],
  });

  assert.match(answer, /`formatDate` is defined in 1 place/);
  assert.match(answer, /`src\/date\.js` \(L1–3, function, exported\)/);
  assert.match(answer, /referenced in 1 file/);
  assert.match(answer, /`src\/date\.js` \(line 4\)/);
});

test("answers an unreachability question, and stays quiet without entry points", () => {
  const graph = jsGraph(
    [
      { id: 1, path: "index.js" },
      { id: 2, path: "src/orphan.js" },
    ],
    [],
  );

  const answer = answerGraphQuestion({
    question: "which files are unused?",
    graph,
    files: [{ id: 1, path: "index.js" }, { id: 2, path: "src/orphan.js" }],
    entryPaths: ["index.js"],
  });

  assert.match(answer, /1 indexed file is not reachable/);
  assert.match(answer, /`src\/orphan\.js`/);

  const noEntries = answerGraphQuestion({
    question: "which files are unused?",
    graph,
    files: [{ id: 1, path: "index.js" }],
    entryPaths: [],
  });

  assert.match(noEntries, /could not find any entry points/);
});

test("falls through when the question names nothing in the index", () => {
  const graph = jsGraph([{ id: 1, path: "src/app.js" }], []);

  assert.strictEqual(
    answerGraphQuestion({
      question: "what imports nothingatall",
      graph,
      files: [{ id: 1, path: "src/app.js" }],
    }),
    null,
  );
  assert.strictEqual(
    answerGraphQuestion({ question: "how do I run this?", graph, files: [] }),
    null,
  );
});

test("getImpact summarizes files and unreachable modules for a repository", async () => {
  freshDb();
  const repo = makeFixtureRepo({
    "package.json": JSON.stringify({ main: "src/index.js" }),
    "src/index.js": 'import { helper } from "./util";\n\nexport function start() {\n  return helper();\n}\n',
    "src/util.js": "export function helper() {\n  return 1;\n}\n",
    "src/legacy.js": "export const old = 1;\n",
  });

  const { repoId } = await new IndexerService().indexRepo(repo, {
    webContents: { send() {} },
  });

  const overview = getImpact(repoId);

  assert.deepStrictEqual(
    overview.files.map((file) => file.path),
    ["src/index.js", "src/legacy.js", "src/util.js"],
  );
  assert.deepStrictEqual(overview.unreachable, ["src/legacy.js"]);
  assert.strictEqual(overview.hasEntryPoints, true);
  assert.strictEqual(overview.impact, null);

  const impact = getImpact(repoId, "src/util.js");

  assert.deepStrictEqual(
    impact.impact.importers.map((importer) => importer.path),
    ["src/index.js"],
  );
  assert.deepStrictEqual(
    impact.impact.dependents.map((dependent) => dependent.path),
    ["src/index.js"],
  );
});

test("getImpact returns nothing for an unknown repository", () => {
  freshDb();

  assert.deepStrictEqual(getImpact("nope"), {
    files: [],
    unreachable: [],
    hasEntryPoints: false,
    impact: null,
  });
});

test("does not mix another repository's files into impact or reachability", async () => {
  freshDb();
  const repoA = makeFixtureRepo({
    "package.json": JSON.stringify({ main: "index.js" }),
    "index.js": 'import "./src/a";\n',
    "src/a.js": "export const a = 1;\n",
  });
  const repoB = makeFixtureRepo({
    "package.json": JSON.stringify({ main: "index.js" }),
    "index.js": "export const b = 1;\n",
    "src/orphan.js": "export const c = 1;\n",
  });

  const indexer = new IndexerService();
  const { repoId: repoIdA } = await indexer.indexRepo(repoA, {
    webContents: { send() {} },
  });
  const { repoId: repoIdB } = await indexer.indexRepo(repoB, {
    webContents: { send() {} },
  });

  assert.deepStrictEqual(getImpact(repoIdA).unreachable, []);
  assert.deepStrictEqual(getImpact(repoIdB).unreachable, ["src/orphan.js"]);
});

test("answers impact questions end to end from an indexed repository", async () => {
  freshDb();
  const repo = makeFixtureRepo({
    "package.json": JSON.stringify({ main: "src/index.js" }),
    "src/index.js": 'import { helper } from "./util";\n\nexport function start() {\n  return helper();\n}\n',
    "src/util.js": "export function helper() {\n  return 1;\n}\n",
    "src/legacy.js": "export const old = 1;\n",
  });

  const { repoId } = await new IndexerService().indexRepo(repo, {
    webContents: { send() {} },
  });

  const impactAnswer = answerRepositoryGraphQuestion(
    repoId,
    "what imports src/util.js?",
  );

  assert.match(impactAnswer, /`src\/util\.js` is imported directly by 1 file/);
  assert.match(impactAnswer, /`src\/index\.js`/);

  const symbolAnswer = answerRepositoryGraphQuestion(
    repoId,
    "where is helper used?",
  );

  assert.match(symbolAnswer, /`helper` is defined in 1 place/);
  assert.match(symbolAnswer, /`src\/index\.js`/);

  const unreachableAnswer = answerRepositoryGraphQuestion(
    repoId,
    "which files are unused?",
  );

  assert.match(unreachableAnswer, /`src\/legacy\.js`/);

  assert.strictEqual(
    answerRepositoryGraphQuestion(repoId, "how do I run this?"),
    null,
  );
});
