const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase } = require("../electron/db/schema");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");
const {
  loadMain,
  makeGitFixtureRepo,
  git,
  waitFor,
} = require("./helpers/loadMain");

test.after(cleanupTempDirs);

const fileUrl = (localPath) => `file:///${localPath.replace(/\\/g, "/")}`;
const list = (handlers) => handlers.get("repositories:list")({ sender: {} });
const changedCount = (sentEvents) =>
  sentEvents.filter((event) => event.channel === "repositories:changed").length;
const progressCount = (sentEvents) =>
  sentEvents.filter((event) => event.channel === "index-progress").length;

// Pushes a commit onto the fixture repository that stands in for a remote.
function pushCommit(repo, files, message) {
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(repo, relativePath), contents);
  }

  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
}

test("repositories:sync pulls a third-party commit, re-indexes it, and records the tip", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const { handlers, sentEvents } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")(
    { sender: {} },
    fileUrl(repo),
  );
  assert.strictEqual(added.fileCount, 2);

  // Someone else adds a file and pushes.
  pushCommit(repo, { "helpers.js": "const b = 2;\n" }, "add helpers");

  const result = await handlers.get("repositories:sync")(
    { sender: {} },
    added.id,
  );

  assert.deepStrictEqual(result, {
    id: added.id,
    status: "updated",
    changed: true,
  });
  assert.ok(
    fs.existsSync(path.join(added.localPath, "helpers.js")),
    "the new commit must be checked out into the clone",
  );

  const [repository] = await list(handlers);
  assert.strictEqual(repository.fileCount, 3);
  assert.match(repository.commitSha, /^[0-9a-f]{40}$/);
  assert.strictEqual(repository.syncState, null);
  assert.ok(
    changedCount(sentEvents) > 0,
    "the renderer must be told to refresh after a sync",
  );

  // The next pass has nothing left to do.
  const second = await handlers.get("repositories:sync")(
    { sender: {} },
    added.id,
  );
  assert.deepStrictEqual(second, {
    id: added.id,
    status: "unchanged",
    changed: false,
  });
});

test("a rename on the remote is reflected in the index", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const { handlers } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")(
    { sender: {} },
    fileUrl(repo),
  );

  // git records a rename as a delete plus an add; the re-index follows the tree
  // on disk, so the old path has to disappear from the index.
  git(repo, "mv", "index.js", "main.js");
  git(repo, "commit", "-m", "rename index to main");

  const result = await handlers.get("repositories:sync")(
    { sender: {} },
    added.id,
  );
  assert.strictEqual(result.status, "updated");

  const db = initializeDatabase(
    path.join(userData, "atlas-data", "atlas.db"),
  );
  const paths = db
    .prepare(
      `SELECT f.path FROM files f
         JOIN repos r ON r.id = f.repo_id
        WHERE r.external_id = ?
        ORDER BY f.path`,
    )
    .all(added.id)
    // The indexer stores paths with the platform's separator.
    .map((row) => row.path.replace(/\\/g, "/"));

  assert.deepStrictEqual(paths, ["main.js", "src/app.py"]);
  assert.strictEqual(
    fs.existsSync(path.join(added.localPath, "index.js")),
    false,
  );
});

test("a clone with local edits is held back, then synced when they are discarded", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const { handlers, sentEvents } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")(
    { sender: {} },
    fileUrl(repo),
  );

  // The user edits a tracked file in the clone...
  fs.writeFileSync(path.join(added.localPath, "index.js"), "const a = 999;\n");
  // ...while a third party pushes a new commit.
  pushCommit(repo, { "helpers.js": "const b = 2;\n" }, "add helpers");

  const held = await handlers.get("repositories:sync")({ sender: {} }, added.id);
  assert.deepStrictEqual(held, { id: added.id, status: "dirty", changed: true });

  let [repository] = await list(handlers);
  assert.strictEqual(repository.syncState, "dirty");
  // The edit is preserved and the remote's new file did not land: `reset --hard`
  // would have thrown the user's work away.
  assert.strictEqual(
    fs.readFileSync(path.join(added.localPath, "index.js"), "utf8"),
    "const a = 999;\n",
  );
  assert.strictEqual(
    fs.existsSync(path.join(added.localPath, "helpers.js")),
    false,
  );
  // The index was refreshed once to reflect the edits on disk.
  assert.ok(progressCount(sentEvents) > 0);

  // A second pass knows it is already dirty and does not re-index again.
  const progressBefore = progressCount(sentEvents);
  const again = await handlers.get("repositories:sync")({ sender: {} }, added.id);
  assert.deepStrictEqual(again, {
    id: added.id,
    status: "dirty",
    changed: false,
  });
  assert.strictEqual(progressCount(sentEvents), progressBefore);

  // Discarding is the user's explicit call: the edit goes and the tip lands.
  const inspected = await handlers.get("repositories:discard-changes")(
    { sender: {} },
    added.id,
  );
  assert.strictEqual(
    fs
      .readFileSync(path.join(added.localPath, "index.js"), "utf8")
      .replace(/\r\n/g, "\n"),
    "const a = 1;\n",
  );
  assert.ok(fs.existsSync(path.join(added.localPath, "helpers.js")));
  assert.strictEqual(inspected.fileCount, 3);

  [repository] = await list(handlers);
  assert.strictEqual(repository.syncState, null);
  assert.match(repository.commitSha, /^[0-9a-f]{40}$/);
});

test("a checkout Atlas did not clone is never synced or reset", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const checkout = makeGitFixtureRepo();
  const dbPath = path.join(userData, "atlas-data", "atlas.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // An imported row points at a working copy the user already had, outside the
  // folder Atlas manages.
  initializeDatabase(dbPath)
    .prepare(
      `INSERT INTO repos (name, root_path, url, added_at, external_id, indexed_at, file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy",
      checkout,
      fileUrl(checkout),
      null,
      "legacy-1",
      123,
      2,
    );

  const { handlers } = await loadMain({ userData });

  // Its remote moves forward.
  pushCommit(checkout, { "helpers.js": "const b = 2;\n" }, "add helpers");

  const result = await handlers.get("repositories:sync")(
    { sender: {} },
    "legacy-1",
  );
  assert.deepStrictEqual(result, {
    id: "legacy-1",
    status: "skipped",
    changed: false,
  });

  const [repository] = await list(handlers);
  assert.strictEqual(repository.commitSha, null);
  assert.strictEqual(repository.syncState, null);

  await assert.rejects(
    () =>
      handlers.get("repositories:discard-changes")({ sender: {} }, "legacy-1"),
    /Only repositories Atlas cloned/,
  );
});

test("repositories:sync reports a summary and skips repositories with no remote", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const { handlers } = await loadMain({ userData });

  const added = await handlers.get("repositories:add")(
    { sender: {} },
    fileUrl(repo),
  );

  // A repository with no remote has nothing to compare against, so the pass
  // must not count it.
  const repositoriesRoot = path.join(
    userData,
    "atlas-data",
    "repositories",
  );
  initializeDatabase(path.join(userData, "atlas-data", "atlas.db"))
    .prepare(
      "INSERT INTO repos (name, root_path, indexed_at, file_count) VALUES (?, ?, ?, ?)",
    )
    .run("local-only", path.join(repositoriesRoot, "local-only-1"), 123, 1);

  const summary = await handlers.get("repositories:sync")({ sender: {} });

  assert.deepStrictEqual(summary, {
    checked: 1,
    updated: 0,
    dirty: 0,
    unreachable: 0,
  });
  assert.strictEqual(added.fileCount, 2);
});

test("repositories:sync rejects an unknown repository", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const { handlers } = await loadMain({ userData });

  await assert.rejects(
    () => handlers.get("repositories:sync")({ sender: {} }, "missing"),
    /not found/i,
  );
  await assert.rejects(
    () => handlers.get("repositories:discard-changes")({ sender: {} }, "missing"),
    /not found/i,
  );
});

test("the poller syncs when the window regains focus", async () => {
  const userData = makeTempDir("atlas-userdata-");
  const repo = makeGitFixtureRepo();
  const { handlers, sentEvents, windowListeners } = await loadMain({
    userData,
  });

  const added = await handlers.get("repositories:add")(
    { sender: {} },
    fileUrl(repo),
  );
  pushCommit(repo, { "helpers.js": "const b = 2;\n" }, "add helpers");

  const focus = windowListeners.get("focus");
  assert.ok(focus, "the sync poller must subscribe to window focus");
  const changedBefore = changedCount(sentEvents);

  focus();

  const refreshed = await waitFor(async () => {
    const [repository] = await list(handlers);
    return repository?.fileCount === 3;
  });

  assert.ok(refreshed, "a focused pass must re-index the pushed commit");
  assert.strictEqual((await list(handlers))[0].id, added.id);
  assert.ok(
    changedCount(sentEvents) > changedBefore,
    "the renderer must be told to refresh after a background sync",
  );
});
