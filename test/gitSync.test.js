const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createGit,
  getCurrentBranch,
  getRemoteHeadSha,
  hasLocalTrackedChanges,
  inspectRepositoryUpdate,
  applyRepositoryUpdate,
} = require("../electron/sync/gitSync");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");
const { git } = require("./helpers/loadMain");

test.after(cleanupTempDirs);

function fileUrl(localPath) {
  return `file:///${localPath.replace(/\\/g, "/")}`;
}

// A bare repository standing in for GitHub, plus a working copy used only to
// push commits into it — the app never sees the seed, only the clone.
function makeRemote() {
  const remote = makeTempDir("atlas-sync-remote-");
  git(remote, "init", "--bare", "--initial-branch=main");

  const seed = makeTempDir("atlas-sync-seed-");
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "index.js"), "const a = 1;\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");

  return { remote, seed, url: fileUrl(remote) };
}

// What the app does when a repository is added: a shallow clone into a folder it
// manages.
function shallowClone(url) {
  const clone = path.join(makeTempDir("atlas-sync-clone-"), "repo-1");
  git(path.dirname(clone), "clone", "--depth", "1", url, clone);

  return clone;
}

function commitAndPush(seed, files, message) {
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(seed, relativePath), contents);
  }

  git(seed, "add", ".");
  git(seed, "commit", "-m", message);
  git(seed, "push", "origin", "main");
}

test("a fresh clone with no recorded commit reads as unchanged", async () => {
  const { url } = makeRemote();
  const clone = shallowClone(url);

  const result = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });

  assert.strictEqual(result.status, "unchanged");
  assert.strictEqual(result.branch, "main");
  // With nothing recorded, the commit the clone sits on becomes the baseline.
  assert.match(result.baselineSha, /^[0-9a-f]{40}$/);
  assert.strictEqual(result.baselineSha, result.remoteSha);
});

test("a commit pushed by a third party reads as update-available", async () => {
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);
  const first = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });

  commitAndPush(seed, { "helpers.js": "const b = 2;\n" }, "add helpers");

  const second = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: first.baselineSha,
  });

  assert.strictEqual(second.status, "update-available");
  assert.strictEqual(second.baselineSha, first.baselineSha);
  assert.notStrictEqual(second.remoteSha, first.baselineSha);
});

test("applying an update lands the new file and returns the tip", async () => {
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);
  const first = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });
  commitAndPush(seed, { "helpers.js": "const b = 2;\n" }, "add helpers");
  const update = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: first.baselineSha,
  });

  const landed = await applyRepositoryUpdate(
    { localPath: clone, url },
    { branch: update.branch },
  );

  assert.strictEqual(landed, update.remoteSha);
  assert.ok(fs.existsSync(path.join(clone, "helpers.js")));

  // The clone is now level with the remote, so the next check is a no-op.
  const third = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: landed,
  });
  assert.strictEqual(third.status, "unchanged");
});

test("a local edit to a tracked file holds the update back as dirty", async () => {
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);
  const first = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });
  fs.writeFileSync(path.join(clone, "index.js"), "const a = 999;\n");
  commitAndPush(seed, { "more.js": "const c = 3;\n" }, "more");

  const result = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: first.baselineSha,
  });

  assert.strictEqual(result.status, "dirty");
  // Nothing was fetched, so the edit is still there to be reported and kept.
  assert.strictEqual(
    fs.readFileSync(path.join(clone, "index.js"), "utf8"),
    "const a = 999;\n",
  );
});

test("an untracked file alone does not hold the update back", async () => {
  // `reset --hard` leaves untracked files alone, so one stray file must not park
  // a repository out of sync forever.
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);
  const first = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });
  fs.writeFileSync(path.join(clone, "scratch.tmp"), "scratch\n");
  commitAndPush(seed, { "more.js": "const c = 3;\n" }, "more");

  const result = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: first.baselineSha,
  });

  assert.strictEqual(result.status, "update-available");
});

test("discarding local edits applies the remote tip and keeps it", async () => {
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);
  const first = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: null,
  });
  fs.writeFileSync(path.join(clone, "index.js"), "const a = 999;\n");
  commitAndPush(seed, { "more.js": "const c = 3;\n" }, "more");
  const held = await inspectRepositoryUpdate({
    localPath: clone,
    url,
    commitSha: first.baselineSha,
  });

  const landed = await applyRepositoryUpdate(
    { localPath: clone, url },
    { branch: "main" },
  );

  assert.strictEqual(landed, held.remoteSha);
  // The edit is gone and the remote's version is back.
  assert.strictEqual(
    fs.readFileSync(path.join(clone, "index.js"), "utf8").replace(/\r\n/g, "\n"),
    "const a = 1;\n",
  );
  assert.ok(fs.existsSync(path.join(clone, "more.js")));
});

test("reports the tracked-change state without counting untracked files", async () => {
  const { url } = makeRemote();
  const clone = shallowClone(url);
  const gitClient = createGit(clone);

  assert.strictEqual(await getCurrentBranch(gitClient), "main");
  assert.strictEqual(await hasLocalTrackedChanges(gitClient), false);

  fs.writeFileSync(path.join(clone, "scratch.tmp"), "scratch\n");
  assert.strictEqual(await hasLocalTrackedChanges(gitClient), false);

  fs.writeFileSync(path.join(clone, "index.js"), "const a = 2;\n");
  assert.strictEqual(await hasLocalTrackedChanges(gitClient), true);
});

test("reads the remote tip without transferring the branch", async () => {
  const { seed, url } = makeRemote();
  const clone = shallowClone(url);

  const tip = await getRemoteHeadSha(createGit(clone), url, "main");
  const localHead = await createGit(seed).revparse(["HEAD"]);

  assert.strictEqual(tip, localHead.trim());
});

test("a remote without the branch reports a missing ref", async () => {
  const empty = makeTempDir("atlas-sync-empty-");
  git(empty, "init", "--bare", "--initial-branch=main");
  const clone = shallowClone(makeRemote().url);

  await assert.rejects(
    () => getRemoteHeadSha(createGit(clone), fileUrl(empty), "main"),
    /no ref/i,
  );
});

test("an unreachable remote rejects instead of hanging", async () => {
  const clone = shallowClone(makeRemote().url);

  // The timeout is 30s, so this has to fail on the connection, not the deadline.
  await assert.rejects(() =>
    inspectRepositoryUpdate(
      { localPath: clone, url: "file:///no/such/remote.git", commitSha: null },
      { timeoutMs: 8000 },
    ),
  );
});

test("an environment carrying an editor does not stop git from running", async () => {
  // simple-git refuses any invocation while these are set, and a developer's
  // shell commonly has them exported. The poller must still be able to run.
  const saved = {
    GIT_EDITOR: process.env.GIT_EDITOR,
    GIT_PAGER: process.env.GIT_PAGER,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  };
  process.env.GIT_EDITOR = "notepad";
  process.env.GIT_PAGER = "less";
  process.env.GIT_SSH_COMMAND = "ssh -i /nonexistent";

  try {
    const clone = shallowClone(makeRemote().url);
    assert.strictEqual(await getCurrentBranch(createGit(clone)), "main");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
