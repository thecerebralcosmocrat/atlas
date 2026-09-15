const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { decodeVector } = require("../electron/query/vectors");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

const EMBED_MODEL = "fake-embed";

function makeTempDbPath() {
  const dir = makeTempDir("atlas-chunkdb-");
  return path.join(dir, "atlas.db");
}

function makeFixtureRepo(files) {
  const root = makeTempDir("atlas-chunkrepo-");

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function fakeWindow() {
  return {
    webContents: {
      send: () => {},
    },
  };
}

// Two dimensions per passage so the stored vector is trivially checkable.
function fakeEmbedder() {
  const passages = [];

  return {
    model: EMBED_MODEL,
    passages,
    embedPassages: async (texts) => {
      passages.push(...texts);
      return texts.map((text) => [text.length, 1]);
    },
  };
}

function failingEmbedder() {
  return {
    model: EMBED_MODEL,
    embedPassages: async () => {
      throw new Error("NIM embedding request failed: 429 rate limited");
    },
  };
}

// Returns fewer vectors than it was given. Nothing rejects, so the indexer has
// to notice the mismatch itself.
function shortEmbedder() {
  return {
    model: EMBED_MODEL,
    embedPassages: async () => [[1, 1]],
  };
}

async function withoutErrorNoise(run) {
  const original = console.error;
  console.error = () => {};

  try {
    return await run();
  } finally {
    console.error = original;
  }
}

function chunkRows(db, repoId) {
  return db
    .prepare(
      `SELECT c.*, f.path
         FROM chunks c
         JOIN files f ON f.id = c.file_id
        WHERE f.repo_id = ?
        ORDER BY f.path, c.ordinal`,
    )
    .all(repoId);
}

test("stores a vector for every chunk when an embedder is supplied", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/a.js": "const a = 1;\nconst b = 2;\n",
  });
  const embedder = fakeEmbedder();

  const result = await new IndexerService().indexRepo(repo, fakeWindow(), {}, {
    embedder,
  });

  assert.strictEqual(result.chunkCount, 1);

  const [row] = chunkRows(db, result.repoId);
  const embeddedText = `${row.path}\n${row.content}`;

  assert.strictEqual(row.path, path.join("src", "a.js"));
  assert.strictEqual(row.start_line, 1);
  assert.strictEqual(row.end_line, 2);
  assert.strictEqual(row.model, EMBED_MODEL);
  assert.strictEqual(row.dims, 2);
  assert.deepStrictEqual(
    [...decodeVector(row.embedding)],
    [embeddedText.length, 1],
  );
});

test("embeds the path with the chunk so filename questions can match", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "src/router.js": "const routes = [];\n",
  });
  const embedder = fakeEmbedder();

  await new IndexerService().indexRepo(repo, fakeWindow(), {}, { embedder });

  assert.deepStrictEqual(embedder.passages, [
    `${path.join("src", "router.js")}\nconst routes = [];`,
  ]);

  // The stored chunk stays bare code, so the path never leaks into an excerpt.
  const [row] = chunkRows(db, 1);
  assert.strictEqual(row.content, "const routes = [];");
});

test("indexing without an embedder still indexes the files", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n" });

  const result = await new IndexerService().indexRepo(repo, fakeWindow());

  assert.strictEqual(result.fileCount, 1);
  assert.strictEqual(result.chunkCount, 0);
  assert.deepStrictEqual(chunkRows(db, result.repoId), []);
});

test("a failed embedding leaves the repository indexed but without chunks", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n", "b.js": "let b;\n" });

  const result = await withoutErrorNoise(() =>
    new IndexerService().indexRepo(repo, fakeWindow(), {}, {
      embedder: failingEmbedder(),
    }),
  );

  // Embedding is an enhancement: the index is still complete and retrieval
  // falls back to lexical rather than the whole index failing.
  assert.strictEqual(result.fileCount, 2);
  assert.strictEqual(result.chunkCount, 0);
  assert.deepStrictEqual(chunkRows(db, result.repoId), []);
});

test("a short embedding response leaves the repository indexed but without chunks", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n", "b.js": "let b;\n" });

  // The vectors that did arrive belong to other chunks, so storing them would
  // put every later chunk's meaning on the wrong row.
  const result = await withoutErrorNoise(() =>
    new IndexerService().indexRepo(repo, fakeWindow(), {}, {
      embedder: shortEmbedder(),
    }),
  );

  assert.strictEqual(result.fileCount, 2);
  assert.strictEqual(result.chunkCount, 0);
  assert.deepStrictEqual(chunkRows(db, result.repoId), []);
});

test("re-indexing with a working embedder adds the missing chunks", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n" });
  const indexer = new IndexerService();

  await indexer.indexRepo(repo, fakeWindow());
  const result = await indexer.indexRepo(repo, fakeWindow(), {}, {
    embedder: fakeEmbedder(),
  });

  assert.strictEqual(result.chunkCount, 1);
  assert.strictEqual(chunkRows(db, result.repoId).length, 1);
});

test("re-indexing replaces chunks instead of duplicating them", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n" });
  const indexer = new IndexerService();

  const first = await indexer.indexRepo(repo, fakeWindow(), {}, {
    embedder: fakeEmbedder(),
  });
  const second = await indexer.indexRepo(repo, fakeWindow(), {}, {
    embedder: fakeEmbedder(),
  });

  assert.strictEqual(first.chunkCount, second.chunkCount);
  assert.strictEqual(chunkRows(db, second.repoId).length, second.chunkCount);
});

test("re-indexing drops the chunks of files that no longer exist", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({ "a.js": "let a;\n", "b.js": "let b;\n" });
  const indexer = new IndexerService();

  await indexer.indexRepo(repo, fakeWindow(), {}, { embedder: fakeEmbedder() });
  fs.rmSync(path.join(repo, "b.js"));
  const result = await indexer.indexRepo(repo, fakeWindow(), {}, {
    embedder: fakeEmbedder(),
  });

  const remaining = chunkRows(db, result.repoId);

  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].path, "a.js");
});

test("chunking a large file produces several chunks that all share the file id", async () => {
  const db = initializeDatabase(makeTempDbPath());
  const repo = makeFixtureRepo({
    "big.js": Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join(
      "\n",
    ),
  });

  const result = await new IndexerService().indexRepo(repo, fakeWindow(), {}, {
    embedder: fakeEmbedder(),
  });
  const rows = chunkRows(db, result.repoId);

  assert.ok(rows.length > 1, "a 90-line file should not be one chunk");
  assert.strictEqual(new Set(rows.map((row) => row.file_id)).size, 1);
  assert.deepStrictEqual(
    rows.map((row) => row.ordinal),
    rows.map((_, index) => index),
  );
});
