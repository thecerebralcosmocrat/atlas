const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const {
  rankChunks,
  semanticSearch,
  retrieveRepositoryExcerpts,
} = require("../electron/query/search");
const { encodeVector, decodeVector } = require("../electron/query/vectors");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

const EMBED_MODEL = "fake-embed";

// A stand-in for the NIM embedder: three axes, plus a synonym so a question can
// be phrased with none of the words the code contains. Similarity is therefore
// something the test controls rather than something it hopes the network
// reproduces.
const AXES = ["alpha", "beta", "gamma"];
const SYNONYMS = { login: "alpha", signin: "alpha" };

function textVector(text) {
  const terms = String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map((term) => SYNONYMS[term] ?? term);
  const raw = AXES.map((axis) => (terms?.includes(axis) ? 1 : 0));
  const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0));

  return raw.map((value) => value / (norm || 1));
}

function fakeEmbedder({ model = EMBED_MODEL, queryVector } = {}) {
  return {
    model,
    embedPassages: async (texts) => texts.map(textVector),
    embedQuery: async (text) => queryVector ?? textVector(text),
  };
}

function throwingEmbedder() {
  return {
    model: EMBED_MODEL,
    embedPassages: async () => {
      throw new Error("429 rate limited");
    },
    embedQuery: async () => {
      throw new Error("429 rate limited");
    },
  };
}

function freshDb() {
  const dir = makeTempDir("atlas-retrievaldb-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function insertRepo(db, externalId = "repo-1") {
  db.prepare(
    `INSERT INTO repos (name, root_path, indexed_at, file_count, external_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("repo", `C:/data/repos/${externalId}`, 1, 1, externalId);

  return db
    .prepare("SELECT id FROM repos WHERE external_id = ?")
    .get(externalId).id;
}

function insertFile(db, repoId, filePath, rawContent = "") {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(repoId, filePath, `C:/abs/${filePath}`, "js", 1, rawContent, 1);

  return Number(lastInsertRowid);
}

function insertChunk(db, fileId, chunk) {
  db.prepare(
    `INSERT INTO chunks (file_id, ordinal, start_line, end_line, content, embedding, dims, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fileId,
    chunk.ordinal ?? 0,
    chunk.startLine ?? 1,
    chunk.endLine ?? 1,
    chunk.content,
    encodeVector(chunk.vector),
    chunk.vector.length,
    chunk.model ?? EMBED_MODEL,
  );
}

// The retrieval fallback logs by design. The tests assert the behaviour it
// produces, not the log, so keep the test output readable.
async function withoutErrorNoise(run) {
  const original = console.error;
  console.error = () => {};

  try {
    return await run();
  } finally {
    console.error = original;
  }
}

function chunkRow({ path: filePath, vector, ...rest }) {
  return {
    path: filePath,
    language: "js",
    startLine: rest.startLine ?? 1,
    endLine: rest.endLine ?? 1,
    content: rest.content ?? "code",
    embedding: encodeVector(vector),
  };
}

// --- rankChunks -------------------------------------------------------------

test("ranks the chunk closest in meaning first", () => {
  const rows = [
    chunkRow({ path: "src/beta.js", vector: textVector("beta") }),
    chunkRow({ path: "src/alpha.js", vector: textVector("alpha") }),
  ];

  const results = rankChunks(textVector("alpha"), rows);

  assert.strictEqual(results[0].path, "src/alpha.js");
  assert.strictEqual(results[0].score, 1);
});

test("drops chunks with no similarity to the question", () => {
  const rows = [
    chunkRow({ path: "src/alpha.js", vector: textVector("alpha") }),
    chunkRow({ path: "src/beta.js", vector: textVector("beta") }),
  ];

  const results = rankChunks(textVector("alpha"), rows);

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/alpha.js"],
  );
});

test("drops a chunk whose stored vector holds no numbers", () => {
  // Non-numeric values survive JSON but not arithmetic, so the similarity is
  // NaN. The dimensions deliberately match the question vector, so the drop
  // can only be the NaN check and not a dimension mismatch.
  const rows = [
    chunkRow({ path: "src/poisoned.js", vector: [NaN, NaN, NaN] }),
    chunkRow({ path: "src/alpha.js", vector: textVector("alpha") }),
  ];

  const results = rankChunks(textVector("alpha"), rows);

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/alpha.js"],
  );
});

test("keeps only the best chunk per file", () => {
  const rows = [
    chunkRow({
      path: "src/alpha.js",
      vector: textVector("alpha"),
      startLine: 1,
      content: "the strong match",
    }),
    chunkRow({
      path: "src/alpha.js",
      vector: textVector("alpha gamma"),
      startLine: 50,
      content: "a weaker match",
    }),
    chunkRow({ path: "src/beta.js", vector: textVector("beta") }),
  ];

  const results = rankChunks(textVector("alpha"), rows, { limit: 5 });
  const alphaChunks = results.filter((result) => result.path === "src/alpha.js");

  assert.strictEqual(alphaChunks.length, 1);
  assert.strictEqual(alphaChunks[0].content, "the strong match");
  assert.strictEqual(alphaChunks[0].startLine, 1);
});

test("respects the limit and the total character budget", () => {
  const rows = ["alpha", "alpha beta", "beta alpha", "alpha gamma"].map(
    (text, index) =>
      chunkRow({
        path: `src/file${index}.js`,
        vector: textVector(text),
        content: "x".repeat(100),
      }),
  );

  assert.strictEqual(rankChunks(textVector("alpha"), rows, { limit: 2 }).length, 2);
  assert.strictEqual(
    rankChunks(textVector("alpha"), rows, { maxTotalChars: 150 }).length,
    1,
  );
});

test("clips an over-long chunk and shortens its cited line range", () => {
  const content = ["line 10", "line 11", "line 12", "line 13"].join("\n");
  const rows = [
    chunkRow({
      path: "src/alpha.js",
      vector: textVector("alpha"),
      startLine: 10,
      endLine: 13,
      content,
    }),
  ];

  const [result] = rankChunks(textVector("alpha"), rows, { maxExcerptChars: 8 });

  // Only one line survived the clip, so the range must not claim the other
  // three: the reader would be told to look at lines that were never shown.
  assert.strictEqual(result.startLine, 10);
  assert.strictEqual(result.endLine, 10);
  assert.strictEqual(result.content, "line 10\n…");
});

// --- semanticSearch ---------------------------------------------------------

test("answers from chunks without an embedder by returning nothing", async () => {
  freshDb();

  assert.deepStrictEqual(await semanticSearch("repo-1", "alpha"), []);
});

test("returns nothing for a repository that was never indexed", async () => {
  freshDb();

  assert.deepStrictEqual(
    await semanticSearch("missing", "alpha", { embedder: fakeEmbedder() }),
    [],
  );
});

test("ignores chunks embedded by a model that is no longer configured", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const alphaFile = insertFile(db, repoId, "src/alpha.js");
  const betaFile = insertFile(db, repoId, "src/beta.js");

  // The beta chunk is the perfect match, but it lives in another model's
  // vector space, so scoring it would rank an unrelated chunk.
  insertChunk(db, alphaFile, {
    content: "alpha gamma",
    vector: textVector("alpha gamma"),
  });
  insertChunk(db, betaFile, {
    content: "alpha",
    vector: textVector("alpha"),
    model: "retired-embed",
  });

  const results = await semanticSearch("repo-1", "alpha", {
    embedder: fakeEmbedder(),
  });

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/alpha.js"],
  );
});

test("finds a chunk that shares no wording with the question", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/alpha.js", "export const x = 1;");

  insertChunk(db, fileId, {
    content: "export const x = 1;",
    vector: textVector("alpha"),
  });

  const results = await semanticSearch("repo-1", "login", {
    embedder: fakeEmbedder(),
  });

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].content, "export const x = 1;");
  assert.strictEqual(results[0].language, "js");
});

test("decodes stored vectors into scores rather than raw bytes", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/alpha.js");

  insertChunk(db, fileId, { content: "a", vector: textVector("alpha") });

  const [result] = await semanticSearch("repo-1", "alpha", {
    embedder: fakeEmbedder(),
  });

  assert.ok(result.score > 0.99, `expected a near-perfect cosine, got ${result.score}`);
});

// --- retrieveRepositoryExcerpts --------------------------------------------

test("prefers the semantic result when chunks are available", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/alpha.js", "export const x = 1;");

  insertChunk(db, fileId, {
    content: "export const x = 1;",
    vector: textVector("alpha"),
  });

  const results = await retrieveRepositoryExcerpts("repo-1", "login", {
    embedder: fakeEmbedder(),
  });

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/alpha.js"],
  );
});

test("falls back to lexical ranking when the embedder fails", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  insertFile(db, repoId, "src/login.js", "export function login() {}\n");

  const results = await withoutErrorNoise(() =>
    retrieveRepositoryExcerpts("repo-1", "where is login defined", {
      embedder: throwingEmbedder(),
    }),
  );

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/login.js"],
  );
});

test("falls back to lexical ranking for a repository indexed without chunks", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  insertFile(db, repoId, "src/login.js", "export function login() {}\n");

  const results = await retrieveRepositoryExcerpts("repo-1", "where is login", {
    embedder: fakeEmbedder(),
  });

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/login.js"],
  );
});

test("falls back to lexical ranking when every stored vector is unusable", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/login.js", "export function login() {}\n");

  // A repository whose vectors are all NaN would otherwise be answered from
  // scores nothing can be ordered by, instead of the lexical pass.
  insertChunk(db, fileId, { vector: [NaN, NaN, NaN], content: "export function login() {}" });

  const results = await retrieveRepositoryExcerpts("repo-1", "where is login", {
    embedder: fakeEmbedder(),
  });

  assert.deepStrictEqual(
    results.map((result) => result.path),
    ["src/login.js"],
  );
  // The lexical pass scores with a real number; keeping the discarded chunk
  // would have cited this file with a NaN score instead.
  assert.ok(Number.isFinite(results[0].score));
});

test("returns nothing when neither retrieval path has a candidate", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  insertFile(db, repoId, "src/alpha.js", "export const x = 1;\n");

  // No chunks, and the question shares no term with the file.
  const results = await retrieveRepositoryExcerpts("repo-1", "zzz", {
    embedder: fakeEmbedder(),
  });

  assert.deepStrictEqual(results, []);
});

test("the semantic path returns whole chunks, not re-windowed excerpts", async () => {
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/alpha.js");
  const content = ["line 1", "line 2", "line 3"].join("\n");

  insertChunk(db, fileId, {
    content,
    vector: textVector("alpha"),
    startLine: 40,
    endLine: 42,
  });

  const [result] = await retrieveRepositoryExcerpts("repo-1", "alpha", {
    embedder: fakeEmbedder(),
  });

  assert.strictEqual(result.content, content);
  assert.strictEqual(result.startLine, 40);
  assert.strictEqual(result.endLine, 42);
});

test("a vector stored under the configured model is round-trippable from the database", () => {
  // Guards the encode/decode pair used on both sides of the chunk table: a
  // mismatch here would score every chunk as zero without erroring.
  const db = freshDb();
  const repoId = insertRepo(db);
  const fileId = insertFile(db, repoId, "src/alpha.js");
  const vector = textVector("alpha gamma");

  insertChunk(db, fileId, { content: "a", vector });

  const row = db.prepare("SELECT embedding, dims, model FROM chunks").get();

  // Vectors are stored as Float32, so the round trip is compared against the
  // same precision the column can hold.
  assert.deepStrictEqual(
    [...decodeVector(row.embedding)],
    [...Float32Array.from(vector)],
  );
  assert.strictEqual(row.dims, AXES.length);
  assert.strictEqual(row.model, EMBED_MODEL);
});
