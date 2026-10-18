const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase, DEFAULT_WORKSPACE_NAME } = require("../electron/db/schema");
const {
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  listProfiles,
  findProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  moveRepositoryToProfile,
} = require("../electron/db/profiles");
const {
  listRepositories,
  listSyncableRepositories,
  importLegacyRepositories,
} = require("../electron/db/repositories");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-profiles-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function insertRepository(db, { name, path: rootPath, externalId = null, workspaceId = null } = {}) {
  db.prepare(
    `INSERT INTO repos (name, root_path, external_id, workspace_id)
     VALUES (?, ?, ?, ?)`,
  ).run(name, rootPath, externalId, workspaceId);
}

test("seeds exactly one default profile on first launch", () => {
  freshDb();

  const profiles = listProfiles();

  assert.strictEqual(profiles.length, 1);
  assert.strictEqual(profiles[0].name, DEFAULT_WORKSPACE_NAME);
  assert.strictEqual(profiles[0].isDefault, true);
  assert.strictEqual(profiles[0].repositoryCount, 0);
});

test("keeps the seeded default idempotent across re-initialization", () => {
  const dir = makeTempDir("atlas-profiles-reopen-");
  const dbPath = path.join(dir, "atlas.db");

  initializeDatabase(dbPath);
  initializeDatabase(dbPath);

  assert.strictEqual(listProfiles().length, 1);
});

test("lists the default first, then the rest alphabetically, with counts", () => {
  const db = freshDb();
  const zeta = createProfile({ name: "Zeta" });
  const alpha = createProfile({ name: "alpha" });
  const [defaultProfile] = listProfiles();

  insertRepository(db, { name: "a", path: "C:/repos/a", workspaceId: alpha.id });
  insertRepository(db, { name: "b", path: "C:/repos/b", workspaceId: alpha.id });
  insertRepository(db, {
    name: "c",
    path: "C:/repos/c",
    workspaceId: defaultProfile.id,
  });

  assert.deepStrictEqual(
    listProfiles().map((profile) => [profile.name, profile.repositoryCount]),
    [
      [DEFAULT_WORKSPACE_NAME, 1],
      ["alpha", 2],
      ["Zeta", 0],
    ],
  );
  assert.strictEqual(zeta.repositoryCount, 0);
});

test("creates a profile with trimmed fields", () => {
  freshDb();

  const profile = createProfile({
    name: "  Work  ",
    description: "  Day job  ",
  });

  assert.strictEqual(profile.name, "Work");
  assert.strictEqual(profile.description, "Day job");
  assert.strictEqual(profile.isDefault, false);
  assert.strictEqual(findProfile(profile.id).name, "Work");
  // Numeric strings from the renderer resolve too.
  assert.strictEqual(findProfile(String(profile.id)).name, "Work");
});

test("rejects blank, overlong, and duplicate profile fields", () => {
  freshDb();
  createProfile({ name: "Work" });

  assert.throws(() => createProfile({ name: "   " }), /name is required/i);
  assert.throws(
    () => createProfile({ name: "x".repeat(MAX_PROFILE_NAME_LENGTH + 1) }),
    /characters or fewer/i,
  );
  assert.throws(
    () =>
      createProfile({
        name: "Big",
        description: "x".repeat(MAX_PROFILE_DESCRIPTION_LENGTH + 1),
      }),
    /characters or fewer/i,
  );

  // The unique index is case-insensitive, so the readable error must be too.
  assert.throws(() => createProfile({ name: "work" }), /already exists/i);
  assert.strictEqual(listProfiles().length, 2);
});

test("updates only the fields it is given", () => {
  freshDb();
  const profile = createProfile({ name: "Work", description: "Day job" });

  const renamed = updateProfile(profile.id, { name: "  Office  " });
  assert.strictEqual(renamed.name, "Office");
  assert.strictEqual(renamed.description, "Day job");

  const described = updateProfile(profile.id, { description: "  Ships  " });
  assert.strictEqual(described.name, "Office");
  assert.strictEqual(described.description, "Ships");

  assert.throws(
    () => updateProfile(profile.id, { name: DEFAULT_WORKSPACE_NAME }),
    /already exists/i,
  );
  assert.throws(() => updateProfile("missing", { name: "Nope" }), /not found/i);
  assert.throws(() => updateProfile(null, { name: "Nope" }), /not found/i);
});

test("moves a repository by external id and filters lists by profile", () => {
  const db = freshDb();
  const work = createProfile({ name: "Work" });
  const [defaultProfile] = listProfiles();

  insertRepository(db, {
    name: "atlas",
    path: "C:/repos/atlas",
    externalId: "atlas-1",
    workspaceId: defaultProfile.id,
  });
  insertRepository(db, {
    name: "other",
    path: "C:/repos/other",
    externalId: "other-1",
    workspaceId: work.id,
  });

  assert.deepStrictEqual(
    listRepositories(work.id).map((repository) => repository.name),
    ["other"],
  );

  assert.deepStrictEqual(moveRepositoryToProfile("atlas-1", work.id), {
    id: "atlas-1",
    profileId: work.id,
  });

  assert.deepStrictEqual(
    listRepositories(work.id).map((repository) => repository.name).sort(),
    ["atlas", "other"],
  );
  assert.deepStrictEqual(listRepositories(defaultProfile.id), []);

  assert.throws(() => moveRepositoryToProfile("missing", work.id), /Repository not found/i);
  assert.throws(() => moveRepositoryToProfile("atlas-1", 9999), /Profile not found/i);
});

test("deleting a profile moves its repositories to the default", () => {
  const db = freshDb();
  const work = createProfile({ name: "Work" });
  const [defaultProfile] = listProfiles();

  insertRepository(db, {
    name: "doomed",
    path: "C:/repos/doomed",
    workspaceId: work.id,
  });
  const { id: repoId } = db
    .prepare("SELECT id FROM repos WHERE root_path = ?")
    .get("C:/repos/doomed");
  db.prepare(
    `INSERT INTO files (repo_id, path, abs_path, language, loc, raw_content, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, "a.js", "C:/repos/doomed/a.js", "js", 1, "let a;\n", 123);

  assert.deepStrictEqual(deleteProfile(work.id), {
    id: work.id,
    movedRepositoryCount: 1,
  });

  assert.strictEqual(findProfile(work.id), null);
  assert.deepStrictEqual(
    listProfiles().map((profile) => profile.name),
    [DEFAULT_WORKSPACE_NAME],
  );

  const [repository] = listRepositories(defaultProfile.id);
  assert.strictEqual(repository.name, "doomed");
  assert.strictEqual(repository.workspaceId, defaultProfile.id);
  // The indexed data itself is untouched: deleting a profile is a filing
  // decision, not a repository delete.
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(repoId).n,
    1,
  );
});

test("the default profile cannot be deleted", () => {
  freshDb();
  const [defaultProfile] = listProfiles();

  assert.throws(() => deleteProfile(defaultProfile.id), /cannot be deleted/i);
  assert.strictEqual(listProfiles().length, 1);
});

test("rejects deletes for unknown profiles", () => {
  freshDb();

  assert.throws(() => deleteProfile("missing"), /not found/i);
  assert.throws(() => deleteProfile(null), /not found/i);
});

test("importing legacy repositories files them under the default profile", () => {
  freshDb();
  const [defaultProfile] = listProfiles();

  importLegacyRepositories([
    { id: "old-1", name: "old", localPath: "C:/repos/old-1" },
  ]);

  assert.strictEqual(listRepositories()[0].workspaceId, defaultProfile.id);
});

test("indexing without profile metadata falls back to the default", async () => {
  const db = freshDb();
  const [defaultProfile] = listProfiles();
  const root = makeTempDir("atlas-profile-repo-");
  fs.writeFileSync(path.join(root, "a.js"), "let a;\n");

  const result = await new IndexerService().indexRepo(root, null, { name: "atlas" });

  assert.strictEqual(
    db.prepare("SELECT workspace_id FROM repos WHERE id = ?").get(result.repoId)
      .workspace_id,
    defaultProfile.id,
  );
});

test("a repository added after its profile was deleted lands in the default", async () => {
  const db = freshDb();
  const work = createProfile({ name: "Work" });
  const [defaultProfile] = listProfiles();
  // repositories:add reads the active profile up front, then clones. The
  // user deletes that profile while the clone is still running.
  const capturedProfileId = work.id;
  deleteProfile(work.id);

  const root = makeTempDir("atlas-profile-deleted-");
  fs.writeFileSync(path.join(root, "a.js"), "let a;\n");

  const result = await new IndexerService().indexRepo(root, null, {
    name: "new",
    workspaceId: capturedProfileId,
  });

  assert.strictEqual(
    db.prepare("SELECT workspace_id FROM repos WHERE id = ?").get(result.repoId)
      .workspace_id,
    defaultProfile.id,
  );
  // Most importantly, the repository is visible rather than filed under an id
  // that no longer exists.
  assert.deepStrictEqual(
    listRepositories(defaultProfile.id).map((repository) => repository.name),
    ["new"],
  );
});

test("indexing respects an explicit profile without moving an existing one", async () => {
  const db = freshDb();
  const work = createProfile({ name: "Work" });
  const other = createProfile({ name: "Other" });
  const [defaultProfile] = listProfiles();
  const root = makeTempDir("atlas-profile-explicit-");
  fs.writeFileSync(path.join(root, "a.js"), "let a;\n");
  const indexer = new IndexerService();
  const workspaceIdOf = (repoId) =>
    db.prepare("SELECT workspace_id FROM repos WHERE id = ?").get(repoId)
      .workspace_id;

  const first = await indexer.indexRepo(root, null, {
    name: "atlas",
    workspaceId: work.id,
  });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);

  // A re-index from a caller without profile context (the CLI or a sync)
  // must not silently move the repository back to the default.
  await indexer.indexRepo(root, null, { name: "atlas" });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);

  // Even an explicit profile id must not move an existing row. A startup
  // backfill or sync captures the id before its long async work; a move the
  // user makes in the meantime must survive that re-index.
  await indexer.indexRepo(root, null, {
    name: "atlas",
    workspaceId: other.id,
  });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);

  await indexer.indexRepo(root, null, {
    name: "atlas",
    workspaceId: defaultProfile.id,
  });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);
});

test("sync only considers the given profile's repositories when scoped", () => {
  const db = freshDb();
  const work = createProfile({ name: "Work" });
  const [defaultProfile] = listProfiles();

  for (const [name, profileId] of [
    ["personal-repo", defaultProfile.id],
    ["work-repo", work.id],
  ]) {
    db.prepare(
      `INSERT INTO repos (name, root_path, url, external_id, indexed_at, workspace_id)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(name, `C:/repos/${name}`, `https://example.com/${name}.git`, name, profileId);
  }

  const names = (rows) => rows.map((repository) => repository.name).sort();

  assert.deepStrictEqual(names(listSyncableRepositories()), [
    "personal-repo",
    "work-repo",
  ]);
  assert.deepStrictEqual(names(listSyncableRepositories(work.id)), ["work-repo"]);
  assert.deepStrictEqual(names(listSyncableRepositories(defaultProfile.id)), [
    "personal-repo",
  ]);
});
