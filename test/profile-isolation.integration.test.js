const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { closeDatabase } = require("../electron/db/schema");
const { initializeSettings } = require("../electron/settings");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");
const {
  loadMain,
  makeGitFixtureRepo,
  git,
} = require("./helpers/loadMain");

// J3 in docs/testing/atlas-test-plan.md: profile A and profile B stand in for
// two accounts. Every ID-scoped IPC handler must refuse to read or change a
// repository that belongs to the other profile. Until the handlers are scoped
// to the active profile these tests are expected to fail; that failure is the
// specification for the fix.

test.after(cleanupTempDirs);

const ENV_VARIABLES = [
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_NIM_MODEL",
  "NVIDIA_NIM_API_URL",
  "NVIDIA_NIM_EMBED_MODEL",
  "NVIDIA_NIM_EMBED_API_URL",
];

test.beforeEach(() => {
  for (const name of ENV_VARIABLES) delete process.env[name];
});

test.afterEach(() => {
  initializeSettings(null);
});

const EVENT = { sender: {} };
const NOT_FOUND = /Repository not found\./;
const SECRET_FUNCTION = "secretOrbitLedger";
const SECRET_FILE = "ledger.js";
const A_API_KEY = "profile-a-secret-key";

const fileUrl = (localPath) => `file:///${localPath.replace(/\\/g, "/")}`;

function fixtureFiles() {
  return {
    "index.js": "const a = 1;\n",
    [SECRET_FILE]: `function ${SECRET_FUNCTION}() {\n  return "orbit-ledger-entry";\n}\n`,
  };
}

function headOf(clonePath) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: clonePath,
    encoding: "utf8",
  }).trim();
}

// Pushes a commit onto the fixture that stands in for the remote, so a sync
// that wrongly runs would visibly move the clone.
function pushCommit(origin, name, contents) {
  fs.writeFileSync(path.join(origin, name), contents);
  git(origin, "add", ".");
  git(origin, "commit", "-m", `add ${name}`);
}

// Boots the main process on a fresh user-data directory and returns an `invoke`
// that calls handlers the way the renderer's IPC does.
async function launch() {
  closeDatabase();

  const userData = makeTempDir("atlas-isolation-userdata-");
  const { handlers, sentEvents } = await loadMain({ userData });
  const invoke = (channel, ...args) => {
    const handler = handlers.get(channel);

    assert.ok(handler, `expected a handler for ${channel}`);

    return handler(EVENT, ...args);
  };

  return { handlers, invoke, sentEvents };
}

// Profile A (the seeded default) owns an indexed repository; profile B exists
// and is empty. The active profile is left as B, the "other account".
async function ownerAThenBecomeB() {
  const app = await launch();
  const { invoke } = app;

  const profileA = (await invoke("profiles:list"))[0];
  const origin = makeGitFixtureRepo(fixtureFiles());
  const repository = await invoke("repositories:add", fileUrl(origin));
  const profileB = await invoke("profiles:create", { name: "Profile B" });

  await invoke("profiles:switch", profileB.id);

  return { ...app, origin, profileA, profileB, repository };
}

// Profile B (not the default) owns the indexed repository, and the active
// profile is left as A: the same check in the other direction.
async function ownerBThenBecomeA() {
  const app = await launch();
  const { invoke } = app;

  const profileA = (await invoke("profiles:list"))[0];
  const profileB = await invoke("profiles:create", { name: "Profile B" });

  await invoke("profiles:switch", profileB.id);

  const origin = makeGitFixtureRepo(fixtureFiles());
  const repository = await invoke("repositories:add", fileUrl(origin));

  await invoke("profiles:switch", profileA.id);

  return { ...app, origin, profileA, profileB, repository };
}

// Read-only channels may either reject or return nothing, but whatever they
// return must not carry the other profile's content.
async function assertNoLeak(call, label) {
  let result;

  try {
    result = await call();
  } catch {
    return;
  }

  const serialized = JSON.stringify(result ?? null);

  assert.ok(
    !serialized.includes(SECRET_FILE) && !serialized.includes(SECRET_FUNCTION),
    `${label} leaked the other profile's repository: ${serialized.slice(0, 200)}`,
  );
}

function assertCloneIntact(repository) {
  assert.ok(
    fs.existsSync(path.join(repository.localPath, SECRET_FILE)),
    "the owner's clone must still exist with its files",
  );
}

test("repositories:list shows only the active profile's repositories", async () => {
  const { invoke, profileA, repository } = await ownerAThenBecomeB();

  assert.deepStrictEqual(
    await invoke("repositories:list"),
    [],
    "profile B must not see profile A's repository in the sidebar list",
  );

  await invoke("profiles:switch", profileA.id);

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((item) => item.id),
    [repository.id],
    "switching back must show A's repository again",
  );
});

test("profile B cannot inspect or ask about profile A's repository", async () => {
  const { invoke, repository } = await ownerAThenBecomeB();

  await assert.rejects(
    () => invoke("repositories:inspect", repository.id),
    NOT_FOUND,
  );

  await assert.rejects(
    () =>
      invoke("repositories:ask", {
        repositoryId: repository.id,
        question: SECRET_FUNCTION,
      }),
    NOT_FOUND,
  );
});

test("profile B cannot read A's graph, start-here, impact, or ownership data", async () => {
  const { invoke, repository } = await ownerAThenBecomeB();

  await assertNoLeak(
    () => invoke("get-graph", { repoId: repository.id }),
    "get-graph",
  );
  await assertNoLeak(
    () => invoke("get-start-here", { repoId: repository.id }),
    "get-start-here",
  );
  await assertNoLeak(
    () => invoke("get-impact", { repoId: repository.id, path: SECRET_FILE }),
    "get-impact",
  );
  await assertNoLeak(
    () => invoke("get-ownership", { repoId: repository.id, path: SECRET_FILE }),
    "get-ownership",
  );
});

test("profile B cannot remove profile A's repository", async () => {
  const { invoke, profileA, repository } = await ownerAThenBecomeB();

  await assert.rejects(
    () => invoke("repositories:remove", repository.id),
    NOT_FOUND,
  );

  await invoke("profiles:switch", profileA.id);

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((item) => item.id),
    [repository.id],
    "A's row must survive a remove attempted from B",
  );
  assertCloneIntact(repository);
});

test("profile B cannot sync profile A's repository", async () => {
  const { invoke, profileA, origin, repository } = await ownerAThenBecomeB();
  const headBefore = headOf(repository.localPath);

  pushCommit(origin, "later.js", "const later = true;\n");

  await assert.rejects(
    () => invoke("repositories:sync", repository.id),
    NOT_FOUND,
  );

  assert.strictEqual(
    headOf(repository.localPath),
    headBefore,
    "A's clone must not move to the remote tip",
  );
  assert.ok(
    !fs.existsSync(path.join(repository.localPath, "later.js")),
    "the remote commit must not be checked out into A's clone",
  );

  await invoke("profiles:switch", profileA.id);
  assertCloneIntact(repository);
});

test("profile B cannot discard profile A's local edits", async () => {
  const { invoke, origin, repository } = await ownerAThenBecomeB();
  const edited = path.join(repository.localPath, "index.js");

  fs.writeFileSync(edited, "// A's uncommitted work\n");
  pushCommit(origin, "later.js", "const later = true;\n");

  await assert.rejects(
    () => invoke("repositories:discard-changes", repository.id),
    NOT_FOUND,
  );

  assert.strictEqual(
    fs.readFileSync(edited, "utf8"),
    "// A's uncommitted work\n",
    "A's local edit must survive a discard attempted from B",
  );
});

// Profiles are isolated: a repository stays in the profile it was added to.
// There is no channel that moves one, and none that lists every profile's.
test("no channel moves a repository between profiles or lists all of them", async () => {
  const { handlers } = await launch();

  assert.ok(!handlers.has("repositories:move"));
  assert.ok(!handlers.has("get-repos"));
});

test("profile A cannot read or change profile B's repository", async () => {
  const { invoke, profileB, origin, repository } = await ownerBThenBecomeA();
  const headBefore = headOf(repository.localPath);
  const edited = path.join(repository.localPath, "index.js");

  assert.deepStrictEqual(
    await invoke("repositories:list"),
    [],
    "profile A must not see profile B's repository",
  );

  await assert.rejects(
    () => invoke("repositories:inspect", repository.id),
    NOT_FOUND,
  );
  await assertNoLeak(
    () => invoke("get-graph", { repoId: repository.id }),
    "get-graph",
  );

  fs.writeFileSync(edited, "// B's uncommitted work\n");
  pushCommit(origin, "later.js", "const later = true;\n");

  await assert.rejects(
    () => invoke("repositories:sync", repository.id),
    NOT_FOUND,
  );
  await assert.rejects(
    () => invoke("repositories:discard-changes", repository.id),
    NOT_FOUND,
  );
  await assert.rejects(
    () => invoke("repositories:remove", repository.id),
    NOT_FOUND,
  );

  assert.strictEqual(headOf(repository.localPath), headBefore);
  assert.strictEqual(
    fs.readFileSync(edited, "utf8"),
    "// B's uncommitted work\n",
  );
  assertCloneIntact(repository);

  await invoke("profiles:switch", profileB.id);

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((item) => item.id),
    [repository.id],
    "B's row must survive every attempt made from A",
  );
});

test("profile A's API key never appears under profile B", async () => {
  const { invoke, sentEvents } = await launch();

  const profileA = (await invoke("profiles:list"))[0];
  const profileB = await invoke("profiles:create", { name: "Profile B" });

  await invoke("settings:set", { ai: { apiKey: A_API_KEY } });
  assert.strictEqual((await invoke("settings:get")).ai.hasApiKey, true);

  sentEvents.length = 0;
  await invoke("profiles:switch", profileB.id);

  const underB = await invoke("settings:get");

  assert.strictEqual(underB.ai.hasApiKey, false, "B must not inherit A's key");
  assert.ok(!JSON.stringify(underB).includes(A_API_KEY));
  assert.ok(
    !JSON.stringify(sentEvents).includes(A_API_KEY),
    "no event sent to the renderer may carry A's key",
  );

  await invoke("profiles:switch", profileA.id);
  assert.strictEqual((await invoke("settings:get")).ai.hasApiKey, true);
});

test("deleting profile B deletes only B's repositories and clones", async () => {
  const { invoke, profileA, profileB, repository } = await ownerAThenBecomeB();

  // B owns a repository of its own, which is deleted with it, not handed to A.
  const originB = makeGitFixtureRepo({ "b-only.js": "const b = 2;\n" });
  const repositoryB = await invoke("repositories:add", fileUrl(originB));

  assert.ok(fs.existsSync(path.join(repositoryB.localPath, "b-only.js")));

  await invoke("profiles:switch", profileA.id);
  await invoke("profiles:remove", profileB.id);

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((item) => item.id),
    [repository.id],
    "only A's repository remains; B's was deleted, not moved",
  );
  assertCloneIntact(repository);
  assert.ok(
    !fs.existsSync(repositoryB.localPath),
    "B's clone must be deleted from disk with its profile",
  );
});
