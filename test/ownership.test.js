const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { initializeDatabase } = require("../electron/db/schema");
const {
  answerOwnershipQuestion,
  answerRepositoryOwnershipQuestion,
  buildOwnership,
  detectOwnershipIntent,
  getOwnership,
  parseGitLog,
} = require("../electron/query/ownership");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-owndb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function insertRepo(db, name, externalId, rootPath) {
  return db
    .prepare("INSERT INTO repos (name, root_path, external_id) VALUES (?, ?, ?)")
    .run(name, rootPath, externalId).lastInsertRowid;
}

const INSERT_FILE = `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

function insertFile(db, repoId, filePath) {
  db.prepare(INSERT_FILE).run(
    repoId,
    filePath,
    `C:/data/repos/x/${filePath}`,
    "js",
    1,
    "",
    Date.now(),
  );
}

// git exits non-zero on a signing failure by default, and a developer's global
// config must not decide whether the suite passes.
function runGit(cwd, args, env = {}) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30000,
    env: { ...process.env, ...env },
  });
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

// Builds a repository whose commits have explicit authors and dates, so the
// ranking can be asserted without depending on the machine's git identity.
function makeGitRepo(steps) {
  const root = makeTempDir("atlas-ownrepo-");

  runGit(root, ["init"]);

  steps.forEach((step, index) => {
    writeFiles(root, step.files);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", step.message ?? `commit ${index + 1}`], {
      GIT_AUTHOR_NAME: step.name,
      GIT_AUTHOR_EMAIL: step.email,
      GIT_AUTHOR_DATE: step.date,
      GIT_COMMITTER_NAME: step.name,
      GIT_COMMITTER_EMAIL: step.email,
      GIT_COMMITTER_DATE: step.date,
    });
  });

  return root;
}

const PURE_FILES = [
  { id: 1, path: "src/a.js" },
  { id: 2, path: "src/b.js" },
  { id: 3, path: "test/a.test.js" },
  { id: 4, path: "src/never.js" },
];

const PURE_COMMITS = [
  {
    hash: "c1",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2025-01-01T10:00:00+00:00",
    paths: ["src/a.js", "src/b.js", "test/a.test.js"],
  },
  {
    hash: "c2",
    authorName: "Bob",
    authorEmail: "bob@example.com",
    date: "2025-06-01T10:00:00+00:00",
    paths: ["src/a.js"],
  },
  {
    hash: "c3",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2025-07-01T10:00:00+00:00",
    paths: ["src/a.js", "test/a.test.js"],
  },
  {
    hash: "c4",
    authorName: "Bob",
    authorEmail: "bob@example.com",
    date: "2025-08-01T10:00:00+00:00",
    paths: ["test/a.test.js"],
  },
  {
    hash: "c5",
    authorName: "Carol",
    authorEmail: "carol@example.com",
    date: "2025-09-01T10:00:00+00:00",
    paths: ["docs/guide.md"],
  },
];

function pureOwnership() {
  return buildOwnership({ files: PURE_FILES, commits: PURE_COMMITS });
}

test("parses commit headers and their changed paths", () => {
  const raw = [
    "\u001eabc\u001fAlice\u001falice@example.com\u001f2025-07-01T10:00:00+00:00",
    "",
    "src/a.js",
    "src/b.js",
    "\u001edef\u001fBob\u001fbob@example.com\u001f2025-06-01T10:00:00+00:00",
    "",
    "src/a.js",
    "",
  ].join("\n");

  assert.deepStrictEqual(parseGitLog(raw), [
    {
      hash: "abc",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      date: "2025-07-01T10:00:00+00:00",
      paths: ["src/a.js", "src/b.js"],
    },
    {
      hash: "def",
      authorName: "Bob",
      authorEmail: "bob@example.com",
      date: "2025-06-01T10:00:00+00:00",
      paths: ["src/a.js"],
    },
  ]);
});

test("parses an empty log as no commits", () => {
  assert.deepStrictEqual(parseGitLog(""), []);
  assert.deepStrictEqual(parseGitLog(undefined), []);
});

test("annotates each indexed file with its last change and reviewers", () => {
  const { files } = pureOwnership();
  const a = files.find((file) => file.path === "src/a.js");

  assert.strictEqual(a.fileId, 1);
  assert.strictEqual(a.commitCount, 3);
  assert.strictEqual(a.lastChangedAt.slice(0, 10), "2025-07-01");
  assert.strictEqual(a.lastAuthor.name, "Alice");
  assert.deepStrictEqual(
    a.authors.map((author) => [author.name, author.count]),
    [
      ["Alice", 2],
      ["Bob", 1],
    ],
  );
});

test("keeps a zero-commit entry for a file git never touched", () => {
  const { files } = pureOwnership();
  const never = files.find((file) => file.path === "src/never.js");

  assert.deepStrictEqual(never, {
    fileId: 4,
    path: "src/never.js",
    commitCount: 0,
    lastChangedAt: null,
    lastAuthor: null,
    authors: [],
  });
});

test("counts a file's commits and ignores paths outside the index", () => {
  const { files, commitCount } = pureOwnership();

  assert.strictEqual(commitCount, 5);
  assert.strictEqual(files.find((file) => file.path === "src/b.js").commitCount, 1);
  // docs/guide.md was committed but never indexed, and never a file row.
  assert.strictEqual(files.some((file) => file.path === "docs/guide.md"), false);
});

test("ranks churn hotspots and recent changes, leaving tests out", () => {
  const { hotspots, recent } = pureOwnership();

  assert.deepStrictEqual(
    hotspots.map((file) => [file.path, file.commitCount]),
    [
      ["src/a.js", 3],
      ["src/b.js", 1],
    ],
  );
  assert.deepStrictEqual(
    recent.map((file) => [file.path, file.lastChangedAt.slice(0, 10)]),
    [
      ["src/a.js", "2025-07-01"],
      ["src/b.js", "2025-01-01"],
    ],
  );
  assert.strictEqual(
    hotspots.some((file) => file.path === "test/a.test.js"),
    false,
  );
});

test("orders recent changes by real time across UTC offsets", () => {
  const files = [
    { id: 1, path: "src/east.js" },
    { id: 2, path: "src/west.js" },
  ];
  const commits = [
    {
      hash: "c1",
      authorName: "Ann",
      authorEmail: "ann@example.com",
      // 17:00 at -08:00 is 2025-07-02T01:00Z, later than 16:00Z.
      date: "2025-07-01T17:00:00-08:00",
      paths: ["src/west.js"],
    },
    {
      hash: "c2",
      authorName: "Ben",
      authorEmail: "ben@example.com",
      date: "2025-07-01T16:00:00+00:00",
      paths: ["src/east.js"],
    },
  ];

  const { recent } = buildOwnership({ files, commits });

  assert.deepStrictEqual(
    recent.map((file) => file.path),
    ["src/west.js", "src/east.js"],
  );
});

test("ranks contributors by commits and counts their indexed files", () => {
  const { contributors } = pureOwnership();

  assert.deepStrictEqual(
    contributors.map((contributor) => [
      contributor.name,
      contributor.commitCount,
      contributor.fileCount,
    ]),
    [
      ["Alice", 2, 3],
      ["Bob", 2, 2],
      // Carol only touched a docs file, which is not indexed but still counts
      // as a commit.
      ["Carol", 1, 0],
    ],
  );
});

test("classifies ownership and recency questions", () => {
  assert.strictEqual(detectOwnershipIntent("who should I ask about src/util.js"), "owner");
  assert.strictEqual(detectOwnershipIntent("who owns the config module"), "owner");
  assert.strictEqual(detectOwnershipIntent("who changed src/util.js"), "owner");
  assert.strictEqual(detectOwnershipIntent("who are the likely reviewers"), "owner");
  assert.strictEqual(detectOwnershipIntent("what changed recently?"), "recency");
  assert.strictEqual(detectOwnershipIntent("which files are churn hotspots"), "recency");
  assert.strictEqual(detectOwnershipIntent("what is stale here"), "recency");
  assert.strictEqual(detectOwnershipIntent("how do I run this?"), null);
  // Graph questions belong to query/impact.js, which runs first.
  assert.strictEqual(detectOwnershipIntent("what imports src/util.js?"), null);
  assert.strictEqual(detectOwnershipIntent("who uses formatDate"), null);
  assert.strictEqual(detectOwnershipIntent("which files are unused?"), null);
});

test("answers who to ask about a named file", () => {
  const answer = answerOwnershipQuestion({
    question: "who should I ask about src/a.js",
    intent: "owner",
    target: "src/a.js",
    ownership: pureOwnership(),
  });

  assert.match(answer, /`src\/a\.js` has 3 commits/);
  assert.match(answer, /The most likely reviewers are:/);
  assert.match(answer, /`Alice` \(2 commits, last 2025-07-01\)/);
  assert.match(answer, /`Bob` \(1 commit, last 2025-06-01\)/);
});

test("answers a file with no commits honestly", () => {
  const answer = answerOwnershipQuestion({
    question: "who owns src/never.js",
    intent: "owner",
    target: "src/never.js",
    ownership: pureOwnership(),
  });

  assert.match(answer, /`src\/never\.js` has no commits in the available history/);
});

test("falls back to contributors when no file is named", () => {
  const answer = answerOwnershipQuestion({
    question: "who should I ask?",
    intent: "owner",
    target: null,
    ownership: pureOwnership(),
  });

  assert.match(answer, /The people who have changed this repository most are:/);
  assert.match(answer, /`Alice` \(2 commits, 3 indexed files\)/);
  assert.match(answer, /`Carol` \(1 commit, 0 indexed files\)/);
});

test("answers what changed recently", () => {
  const answer = answerOwnershipQuestion({
    question: "what changed recently?",
    intent: "recency",
    ownership: pureOwnership(),
  });

  assert.match(answer, /The indexed history covers 5 commits\./);
  assert.match(answer, /Most frequently changed:/);
  assert.match(answer, /`src\/a\.js` \(3 commits\)/);
  assert.match(answer, /Most recently changed:/);
  assert.match(answer, /`src\/a\.js` \(2025-07-01, Alice\)/);
});

test("says so when there is no history to read", () => {
  const answer = answerOwnershipQuestion({
    question: "who owns this?",
    intent: "owner",
    ownership: buildOwnership({ files: PURE_FILES, commits: [] }),
  });

  assert.match(answer, /could not read any git history/);
});

test("notes a clone whose history is still shallow", () => {
  const answer = answerOwnershipQuestion({
    question: "who should I ask?",
    intent: "owner",
    ownership: pureOwnership(),
    shallow: true,
  });

  assert.match(answer, /This clone only carries 5 commits of history/);
});

test("falls through for a question that is not about ownership", () => {
  assert.strictEqual(
    answerOwnershipQuestion({
      question: "how do I run this?",
      ownership: pureOwnership(),
    }),
    null,
  );
});

test("getOwnership returns nothing for an unknown repository", async () => {
  freshDb();

  assert.deepStrictEqual(await getOwnership("nope"), {
    files: [],
    contributors: [],
    hotspots: [],
    recent: [],
    file: null,
    commitCount: 0,
    shallow: false,
  });
});

test("getOwnership reads a repository's history and ranks its files", async () => {
  const db = freshDb();
  const repo = makeGitRepo([
    {
      name: "Alice",
      email: "alice@example.com",
      date: "2025-01-01T10:00:00+00:00",
      files: {
        "src/a.js": "export const a = 1;\n",
        "src/b.js": "export const b = 1;\n",
        "test/a.test.js": "test 1\n",
      },
    },
    {
      name: "Bob",
      email: "bob@example.com",
      date: "2025-06-01T10:00:00+00:00",
      files: { "src/a.js": "export const a = 2;\n" },
    },
    {
      name: "Alice",
      email: "alice@example.com",
      date: "2025-07-01T10:00:00+00:00",
      files: { "src/a.js": "export const a = 3;\n", "test/a.test.js": "test 2\n" },
    },
    {
      name: "Bob",
      email: "bob@example.com",
      date: "2025-08-01T10:00:00+00:00",
      files: { "test/a.test.js": "test 3\n" },
    },
  ]);
  const repoId = insertRepo(db, "own", "repo-own", repo);

  insertFile(db, repoId, "src/a.js");
  insertFile(db, repoId, "src/b.js");
  insertFile(db, repoId, "test/a.test.js");

  const overview = await getOwnership("repo-own");

  assert.strictEqual(overview.commitCount, 4);
  assert.strictEqual(overview.shallow, false);
  assert.deepStrictEqual(
    overview.hotspots.map((file) => [file.path, file.commitCount]),
    [
      ["src/a.js", 3],
      ["src/b.js", 1],
    ],
  );
  assert.deepStrictEqual(
    overview.recent.map((file) => file.path),
    ["src/a.js", "src/b.js"],
  );
  assert.deepStrictEqual(
    overview.contributors.map((contributor) => [
      contributor.name,
      contributor.commitCount,
      contributor.fileCount,
    ]),
    [
      ["Alice", 2, 3],
      ["Bob", 2, 2],
    ],
  );

  const file = await getOwnership("repo-own", "src/a.js");

  assert.strictEqual(file.file.commitCount, 3);
  assert.strictEqual(file.file.lastChangedAt.slice(0, 10), "2025-07-01");
  assert.deepStrictEqual(
    file.file.authors.map((author) => [author.name, author.count]),
    [
      ["Alice", 2],
      ["Bob", 1],
    ],
  );

  // A test file still has per-file data; it is only hidden from the rankings.
  const testFile = await getOwnership("repo-own", "test/a.test.js");

  assert.strictEqual(testFile.file.commitCount, 3);
});

test("getOwnership tolerates a repository root that is not a git repo", async () => {
  const db = freshDb();
  const plainDir = makeTempDir("atlas-ownplain-");

  insertRepo(db, "plain", "repo-plain", plainDir);

  const overview = await getOwnership("repo-plain");

  assert.strictEqual(overview.commitCount, 0);
  assert.strictEqual(overview.shallow, false);
  assert.deepStrictEqual(overview.hotspots, []);
});

test("deepens a shallow clone once, even for concurrent first readers", async () => {
  const origin = makeGitRepo([
    {
      name: "Alice",
      email: "alice@example.com",
      date: "2025-01-01T10:00:00+00:00",
      files: { "src/old.js": "export const old = 1;\n", "src/new.js": "export const x = 1;\n" },
    },
    {
      name: "Alice",
      email: "alice@example.com",
      date: "2025-02-01T10:00:00+00:00",
      files: { "src/new.js": "export const x = 2;\n" },
    },
  ]);
  const originUrl = `file:///${origin.replace(/\\/g, "/")}`;
  const clone = makeTempDir("atlas-ownclone-");

  runGit(origin, ["clone", "--depth", "1", originUrl, clone]);
  assert.strictEqual(
    runGit(clone, ["rev-parse", "--is-shallow-repository"]).trim(),
    "true",
  );

  const db = freshDb();
  const repoId = insertRepo(db, "clone", "repo-clone", clone);

  insertFile(db, repoId, "src/old.js");
  insertFile(db, repoId, "src/new.js");

  // Two reads in the same tick must share the one fetch: with a cached attempt
  // that only recorded "started", the second reader would log the stale
  // one-commit history before the deepen finished.
  const overviews = await Promise.all([
    getOwnership("repo-clone"),
    getOwnership("repo-clone"),
  ]);

  for (const overview of overviews) {
    // `src/old.js` only appears in the commit the shallow clone did not have,
    // so seeing it proves the history was deepened.
    assert.strictEqual(overview.commitCount, 2);
    assert.deepStrictEqual(
      overview.hotspots.map((file) => [file.path, file.commitCount]),
      [
        ["src/new.js", 2],
        ["src/old.js", 1],
      ],
    );
  }

  // A later read reuses the settled attempt rather than fetching again.
  const cached = await getOwnership("repo-clone");

  assert.strictEqual(cached.commitCount, 2);
});

test("answers ownership questions end to end from an indexed repository", async () => {
  const db = freshDb();
  const repo = makeGitRepo([
    {
      name: "Alice",
      email: "alice@example.com",
      date: "2025-01-01T10:00:00+00:00",
      files: { "src/a.js": "export const a = 1;\n" },
    },
    {
      name: "Bob",
      email: "bob@example.com",
      date: "2025-06-01T10:00:00+00:00",
      files: { "src/a.js": "export const a = 2;\n" },
    },
  ]);
  const repoId = insertRepo(db, "chat", "repo-chat", repo);

  insertFile(db, repoId, "src/a.js");

  const ownerAnswer = await answerRepositoryOwnershipQuestion(
    "repo-chat",
    "who should I ask about src/a.js?",
  );

  assert.match(ownerAnswer, /`src\/a\.js` has 2 commits/);
  assert.match(ownerAnswer, /`Alice`/);
  assert.match(ownerAnswer, /`Bob`/);

  const recencyAnswer = await answerRepositoryOwnershipQuestion(
    "repo-chat",
    "what changed recently?",
  );

  assert.match(recencyAnswer, /Most frequently changed:/);
  assert.match(recencyAnswer, /`src\/a\.js` \(2 commits\)/);

  assert.strictEqual(
    await answerRepositoryOwnershipQuestion("repo-chat", "how do I run this?"),
    null,
  );
});
