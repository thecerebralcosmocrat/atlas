const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");
const { loadMain, makeGitFixtureRepo } = require("./helpers/loadMain");

test.after(cleanupTempDirs);

test("repositories:add clones, indexes, and reports progress before persisting", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;
  const { handlers, sentEvents } = await loadMain({ userData });

  const add = handlers.get("repositories:add");
  assert.ok(add, "repositories:add handler must be registered");

  const result = await add({ sender: {} }, repoUrl);

  assert.strictEqual(result.name, path.basename(repo));
  assert.ok(path.isAbsolute(result.localPath));
  // id and folder name come from a single deterministic slug (no second clock read)
  assert.strictEqual(path.basename(result.localPath), result.id);

  // Progress was pushed to the renderer window during indexing.
  const progress = sentEvents
    .filter((event) => event.channel === "index-progress")
    .map((event) => event.payload);
  assert.deepStrictEqual(progress[0], {
    completed: 0,
    total: 2,
    currentFile: null,
  });
  assert.deepStrictEqual(progress.at(-1), {
    completed: 2,
    total: 2,
    currentFile: null,
  });

  // Files landed in SQLite...
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  const db = initializeDatabase(dbPath);
  const repoRow = db.prepare("SELECT id FROM repos").get();
  assert.ok(repoRow, "repo row must exist");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(
      repoRow.id,
    ).n,
    2,
  );

  // ...and the repository list is served from SQLite.
  const list = handlers.get("repositories:list");
  const repositories = await list({ sender: {} });
  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, result.id);
  assert.strictEqual(repositories[0].localPath, result.localPath);
  assert.strictEqual(repositories[0].url, repoUrl);
  assert.strictEqual(repositories[0].fileCount, 2);
});

test("rejects an invalid repository URL before cloning anything", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const { handlers } = await loadMain({ userData });
  const add = handlers.get("repositories:add");

  await assert.rejects(() => add({ sender: {} }, "not a repository url"), {
    message: /valid repository URL/i,
  });
  await assert.rejects(() => add({ sender: {} }, "   "), {
    message: /valid repository URL/i,
  });

  // Validation runs before the clone, so no repository folder was created.
  const repositoriesRoot = path.join(userData, "atlas-data", "repositories");
  const entries = fs.existsSync(repositoriesRoot)
    ? fs.readdirSync(repositoriesRoot)
    : [];
  assert.deepStrictEqual(entries, []);
});

test("removes the cloned folder when indexing fails", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;

  class FailingIndexer {
    async indexRepo() {
      throw new Error("index exploded");
    }
  }

  const { handlers } = await loadMain({ userData, indexerClass: FailingIndexer });
  const add = handlers.get("repositories:add");

  await assert.rejects(() => add({ sender: {} }, repoUrl), {
    message: /index exploded/,
  });

  // The half-cloned folder must not be left orphaned on disk...
  const repositoriesRoot = path.join(userData, "atlas-data", "repositories");
  assert.deepStrictEqual(fs.readdirSync(repositoriesRoot), []);

  // ...and no repository entry may be recorded.
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  const db = initializeDatabase(dbPath);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM repos").get().n, 0);
});

test("migrates a legacy repositories.json into SQLite on startup", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const atlasData = path.join(userData, "atlas-data");
  fs.mkdirSync(atlasData, { recursive: true });
  fs.writeFileSync(
    path.join(atlasData, "repositories.json"),
    JSON.stringify([
      {
        id: "legacy-slug-1",
        name: "legacy",
        url: "https://example.com/legacy.git",
        localPath: path.join(atlasData, "repositories", "legacy-slug-1"),
        addedAt: "2025-01-01T00:00:00.000Z",
      },
    ]),
    "utf8",
  );

  const { handlers } = await loadMain({ userData });
  const repositories = await handlers.get("repositories:list")({ sender: {} });

  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, "legacy-slug-1");
  assert.strictEqual(repositories[0].url, "https://example.com/legacy.git");
  assert.strictEqual(repositories[0].addedAt, "2025-01-01T00:00:00.000Z");
});

test("a malformed legacy repositories.json does not stop the app starting", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const atlasData = path.join(userData, "atlas-data");
  fs.mkdirSync(atlasData, { recursive: true });
  // Two entries sharing an id but pointing at different paths collide on the
  // unique external_id index, which is what makes the import throw.
  fs.writeFileSync(
    path.join(atlasData, "repositories.json"),
    JSON.stringify([
      { id: "dupe", name: "a", localPath: path.join(atlasData, "repositories", "a") },
      { id: "dupe", name: "b", localPath: path.join(atlasData, "repositories", "b") },
    ]),
    "utf8",
  );

  const { handlers } = await loadMain({ userData });

  // Startup completed: the IPC handlers were registered after the migration.
  assert.ok(handlers.has("repositories:add"));
  // The failed import rolled back, leaving no partial rows.
  const repositories = await handlers.get("repositories:list")({ sender: {} });
  assert.deepStrictEqual(repositories, []);
});

test("startup backfill indexes a repository that was never indexed", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Seed an unindexed row the way the legacy import would have, then let the
  // app's startup backfill pick it up.
  initializeDatabase(dbPath)
    .prepare(
      `INSERT INTO repos (name, root_path, url, added_at, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("legacy-name", repo, "https://example.com/legacy.git", "2025-01-01T00:00:00.000Z", "legacy-1");

  const { handlers, sentEvents } = await loadMain({ userData });

  // The backfill runs after the window opens, so poll until it lands.
  const list = handlers.get("repositories:list");
  const deadline = Date.now() + 5000;
  let repositories = await list({ sender: {} });

  while (Date.now() < deadline && repositories[0]?.fileCount !== 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    repositories = await list({ sender: {} });
  }

  assert.strictEqual(repositories.length, 1);
  assert.strictEqual(repositories[0].id, "legacy-1");
  assert.strictEqual(repositories[0].fileCount, 2);
  // Backfill updates the existing row rather than duplicating or re-cloning it.
  assert.strictEqual(repositories[0].localPath, repo);
  assert.strictEqual(repositories[0].url, "https://example.com/legacy.git");
  assert.strictEqual(repositories[0].addedAt, "2025-01-01T00:00:00.000Z");

  assert.ok(
    sentEvents.some((event) => event.channel === "repositories:changed"),
    "renderer must be told to refresh once backfill completes",
  );
});

test("repositories:ask grounds its answer in indexed file content", async () => {
  const userData = makeTempDir("atlas-userdata-");
  // README.md is deliberately not an indexable extension, so any mention of
  // the source in the answer must come from the indexed file.
  const repo = makeGitFixtureRepo({
    "index.js":
      "function createOrbitIndex(entries) {\n  return entries.map((entry) => entry.path);\n}\n",
    "README.md": "# Fixture\n\nA tiny repository used to test grounded answers.\n",
  });
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;
  const { handlers } = await loadMain({ userData });
  const previousApiKey = process.env.NVIDIA_NIM_API_KEY;

  // Force the local fallback so the assertion is deterministic and offline.
  delete process.env.NVIDIA_NIM_API_KEY;

  try {
    const added = await handlers.get("repositories:add")({ sender: {} }, repoUrl);
    assert.strictEqual(added.fileCount, 1);

    const answer = await handlers.get("repositories:ask")(
      { sender: {} },
      { repositoryId: added.id, question: "createOrbitIndex" },
    );

    assert.match(answer, /createOrbitIndex/);
    assert.match(answer, /index\.js/);
  } finally {
    if (previousApiKey === undefined) delete process.env.NVIDIA_NIM_API_KEY;
    else process.env.NVIDIA_NIM_API_KEY = previousApiKey;
  }
});

test("repositories:remove purges the database, deletes the clone, and notifies the renderer", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;
  const { handlers, sentEvents } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")({ sender: {} }, repoUrl);
  const localPath = added.localPath;
  assert.ok(fs.existsSync(localPath), "clone must exist before removal");

  const removed = await handlers.get("repositories:remove")(
    { sender: {} },
    added.id,
  );
  assert.strictEqual(removed.id, added.id);

  // Gone from the list the sidebar reads...
  assert.deepStrictEqual(
    await handlers.get("repositories:list")({ sender: {} }),
    [],
  );

  // ...its indexed rows are gone too...
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  const db = initializeDatabase(dbPath);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM repos").get().n, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);

  // ...and the cloned folder is off disk.
  assert.strictEqual(fs.existsSync(localPath), false);

  assert.ok(
    sentEvents.some((event) => event.channel === "repositories:changed"),
    "renderer must be told to refresh after a removal",
  );
});

test("repositories:remove keeps a checkout that lives outside the app's repository folder", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // A legacy/imported row points at a checkout the user already had. Removing
  // the repository must not delete that folder.
  initializeDatabase(dbPath)
    .prepare(
      `INSERT INTO repos (name, root_path, url, added_at, external_id, indexed_at, file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy", repo, null, null, "legacy-1", 123, 0);

  const { handlers } = await loadMain({ userData });

  await handlers.get("repositories:remove")({ sender: {} }, "legacy-1");

  assert.deepStrictEqual(
    await handlers.get("repositories:list")({ sender: {} }),
    [],
  );
  assert.ok(fs.existsSync(repo), "the user's own checkout must survive");
});

test("repositories:remove rejects an unknown repository", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const { handlers } = await loadMain({ userData });

  await assert.rejects(
    () => handlers.get("repositories:remove")({ sender: {} }, "missing"),
    { message: /not found/i },
  );
});

test("repositories:ask says so when a repository has nothing indexed", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo({
    "README.md":
      "# Docs only\n\nThis repository contains documentation and no source files at all.\n",
  });
  const repoUrl = `file:///${repo.replace(/\\/g, "/")}`;
  const { handlers } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")({ sender: {} }, repoUrl);
  assert.strictEqual(added.fileCount, 0);

  const answer = await handlers.get("repositories:ask")(
    { sender: {} },
    { repositoryId: added.id, question: "what is this about" },
  );

  assert.match(answer, /not been indexed yet/i);
});

test("a deletion during the startup backfill is not undone by the in-flight index", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Seed an unindexed row so the startup backfill selects it as a target.
  initializeDatabase(dbPath)
    .prepare(
      `INSERT INTO repos (name, root_path, url, added_at, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-name",
      repo,
      "https://example.com/legacy.git",
      "2025-01-01T00:00:00.000Z",
      "legacy-race",
    );

  let markIndexStarted;
  const indexStarted = new Promise((resolve) => {
    markIndexStarted = resolve;
  });
  let releaseIndex;
  const indexGate = new Promise((resolve) => {
    releaseIndex = resolve;
  });
  let didUpsert = false;

  // Blocks inside indexRepo so a removal can land mid-index, then rewrites the
  // repository row exactly as the real indexer's upsert does — which is what
  // would resurrect a repository deleted while the index was in flight.
  class BlockingIndexer {
    async indexRepo(localPath, _window, repository) {
      markIndexStarted();
      await indexGate;
      initializeDatabase(dbPath)
        .prepare(
          `INSERT INTO repos (name, root_path, url, added_at, external_id, indexed_at, file_count)
           VALUES (?, ?, ?, ?, ?, 123, 2)
           ON CONFLICT(root_path) DO UPDATE SET indexed_at = 123, file_count = 2`,
        )
        .run(
          repository.name,
          localPath,
          repository.url,
          repository.addedAt,
          repository.externalId,
        );
      didUpsert = true;
    }
  }

  const { handlers, sentEvents } = await loadMain({
    userData,
    indexerClass: BlockingIndexer,
  });

  await indexStarted;

  // Delete the repository while its index is still running.
  const removed = await handlers.get("repositories:remove")(
    { sender: {} },
    "legacy-race",
  );
  assert.strictEqual(removed.id, "legacy-race");
  assert.deepStrictEqual(
    await handlers.get("repositories:list")({ sender: {} }),
    [],
  );
  const changedAfterRemove = sentEvents.filter(
    (event) => event.channel === "repositories:changed",
  ).length;

  // Let the in-flight index commit its row rewrite, then wait for the backfill
  // to finish so its cleanup (if any) has run.
  releaseIndex();
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    sentEvents.filter((event) => event.channel === "repositories:changed")
      .length <= changedAfterRemove
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(didUpsert, "the in-flight index must have rewritten the row");
  assert.strictEqual(
    initializeDatabase(dbPath).prepare("SELECT COUNT(*) AS n FROM repos").get().n,
    0,
    "the deleted repository must not reappear once the in-flight index commits",
  );
  assert.deepStrictEqual(
    await handlers.get("repositories:list")({ sender: {} }),
    [],
  );
});

