const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { rankFiles, searchRepositoryFiles } = require("../electron/query/search");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-searchdb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

test("ranks the file containing the asked-about symbol first", () => {
  const files = [
    {
      path: "src/alpha.js",
      language: "js",
      rawContent: "export function alpha() {\n  return 1;\n}\n",
    },
    {
      path: "src/auth.js",
      language: "js",
      rawContent:
        "export function authenticateUser(token) {\n  return verifyToken(token);\n}\n",
    },
  ];

  const results = rankFiles("where is authenticateUser defined", files);

  assert.strictEqual(results[0].path, "src/auth.js");
  assert.match(results[0].content, /authenticateUser/);
});

test("a path match outranks a content-only match", () => {
  const files = [
    {
      path: "docs/notes.txt",
      rawContent: "database database database database",
    },
    { path: "src/database.js", rawContent: "const x = 1;" },
  ];

  const results = rankFiles("database", files);

  assert.strictEqual(results[0].path, "src/database.js");
});

test("excerpt is centered on the matching lines and reports 1-based line numbers", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  lines[39] = "const uniqueMarker = 1;";
  const file = { path: "big.js", language: "js", rawContent: lines.join("\n") };

  const [excerpt] = rankFiles("uniqueMarker", [file], { maxSnippetLines: 10 });

  assert.ok(excerpt.startLine <= 40, "excerpt must start at or before the match");
  assert.ok(excerpt.endLine >= 40, "excerpt must end at or after the match");
  assert.match(excerpt.content, /uniqueMarker/);
  assert.ok(excerpt.content.split("\n").length <= 10);
});

test("returns nothing for a question made only of stopwords", () => {
  const files = [{ path: "src/app.js", rawContent: "const a = 1;" }];

  assert.deepStrictEqual(rankFiles("what does this repo do?", files), []);
});

test("returns nothing when no file matches", () => {
  const files = [{ path: "src/app.js", rawContent: "const a = 1;" }];

  assert.deepStrictEqual(rankFiles("nonexistentSymbol", files), []);
});

test("respects the result limit", () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    path: `src/f${index}.js`,
    rawContent: `const sharedToken = ${index};`,
  }));

  const results = rankFiles("sharedToken", files, { limit: 3 });

  assert.strictEqual(results.length, 3);
});

test("caps how much of a large file is returned", () => {
  const file = {
    path: "huge.js",
    language: "js",
    rawContent: `needle\n${"x".repeat(5000)}`,
  };

  const [excerpt] = rankFiles("needle", [file], { maxExcerptChars: 100 });

  assert.ok(excerpt.content.length <= 104, "excerpt must be truncated");
  assert.match(excerpt.content, /…$/);
});

test("trims the cited line range to the lines actually shown when truncated", () => {
  const filler = "x".repeat(50);
  const lines = Array.from(
    { length: 80 },
    (_, index) => `const needle${index} = "${filler}";`,
  );
  const file = { path: "big.js", language: "js", rawContent: lines.join("\n") };

  const [excerpt] = rankFiles("needle", [file], {
    maxSnippetLines: 40,
    maxExcerptChars: 200,
  });

  const shownLines = excerpt.content.replace(/\n…$/, "").split("\n");
  assert.match(excerpt.content, /…$/);
  assert.strictEqual(
    excerpt.endLine - excerpt.startLine + 1,
    shownLines.length,
    "cited range must match the lines actually shown",
  );
  assert.ok(
    excerpt.endLine - excerpt.startLine + 1 < 40,
    "range must be trimmed below the retrieval window",
  );
});

test("does not cite a line for a newline the truncation lands on", () => {
  const file = {
    path: "src/needle.js",
    language: "js",
    rawContent: "needle\nsecond line that is comfortably long\nthird line\n",
  };

  // 7 chars is exactly "needle\n": the excerpt keeps one line, not two.
  const [excerpt] = rankFiles("needle", [file], { maxExcerptChars: 7 });

  assert.strictEqual(excerpt.content, "needle\n…");
  assert.strictEqual(excerpt.startLine, 1);
  assert.strictEqual(excerpt.endLine, 1);
});

test("retrieves indexed content by external id and by numeric id", () => {
  const db = freshDb();
  const { lastInsertRowid: repoId } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("atlas", "C:/data/repos/atlas-1", "atlas-1");
  db.prepare(
    `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repoId,
    "src/db.js",
    "C:/data/repos/atlas-1/src/db.js",
    "js",
    2,
    "function initializeDatabase() {}\n",
    Date.now(),
  );

  const byExternalId = searchRepositoryFiles("atlas-1", "initializeDatabase");
  assert.strictEqual(byExternalId[0].path, "src/db.js");

  const byNumericId = searchRepositoryFiles(String(repoId), "initializeDatabase");
  assert.strictEqual(byNumericId[0].path, "src/db.js");
});

test("returns nothing when the repository has no indexed files", () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)",
  ).run("empty", "C:/data/repos/empty-1", "empty-1");

  assert.deepStrictEqual(searchRepositoryFiles("empty-1", "anything"), []);
});

test("does not return files from another repository", () => {
  const db = freshDb();
  const { lastInsertRowid: repoA } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("a", "C:/data/repos/a", "repo-a");
  const { lastInsertRowid: repoB } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("b", "C:/data/repos/b", "repo-b");
  const insertFile = db.prepare(
    `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFile.run(
    repoA,
    "src/orbit.js",
    "C:/data/repos/a/src/orbit.js",
    "js",
    1,
    "function createOrbitIndex() {}\n",
    Date.now(),
  );
  insertFile.run(
    repoB,
    "src/other.js",
    "C:/data/repos/b/src/other.js",
    "js",
    1,
    "const unrelated = true;\n",
    Date.now(),
  );

  assert.strictEqual(
    searchRepositoryFiles("repo-a", "createOrbitIndex")[0].path,
    "src/orbit.js",
  );
  assert.deepStrictEqual(searchRepositoryFiles("repo-b", "createOrbitIndex"), []);
});

test("a numeric-looking external id does not union in another repository's files", () => {
  const db = freshDb();
  const { lastInsertRowid: repoAId } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("a", "C:/data/repos/a", "alpha");
  // Repo B's external id is literally repo A's primary key. Resolving that id
  // must pick the external-id match (B) rather than unioning A in via the
  // numeric-key branch.
  const { lastInsertRowid: repoBId } = db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run("b", "C:/data/repos/b", String(repoAId));
  const insertFile = db.prepare(
    `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFile.run(
    repoAId,
    "src/a.js",
    "C:/data/repos/a/src/a.js",
    "js",
    1,
    "function createOrbitIndex() {}\n",
    Date.now(),
  );
  insertFile.run(
    repoBId,
    "src/b.js",
    "C:/data/repos/b/src/b.js",
    "js",
    1,
    "function createOrbitIndex() {}\n",
    Date.now(),
  );

  const results = searchRepositoryFiles(String(repoAId), "createOrbitIndex");

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/b.js"],
  );
});
