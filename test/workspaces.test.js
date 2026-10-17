const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase, DEFAULT_WORKSPACE_NAME } = require("../electron/db/schema");
const {
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  listWorkspaces,
  findWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  moveRepositoryToWorkspace,
} = require("../electron/db/workspaces");
const {
  listRepositories,
  importLegacyRepositories,
} = require("../electron/db/repositories");
const { IndexerService } = require("../electron/indexer/IndexerService");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

function freshDb() {
  const dir = makeTempDir("atlas-workspaces-");
  return initializeDatabase(path.join(dir, "atlas.db"));
}

function insertRepository(db, { name, path: rootPath, externalId = null, workspaceId = null } = {}) {
  db.prepare(
    `INSERT INTO repos (name, root_path, external_id, workspace_id)
     VALUES (?, ?, ?, ?)`,
  ).run(name, rootPath, externalId, workspaceId);
}

test("seeds exactly one default workspace on first launch", () => {
  freshDb();

  const workspaces = listWorkspaces();

  assert.strictEqual(workspaces.length, 1);
  assert.strictEqual(workspaces[0].name, DEFAULT_WORKSPACE_NAME);
  assert.strictEqual(workspaces[0].isDefault, true);
  assert.strictEqual(workspaces[0].repositoryCount, 0);
});

test("keeps the seeded default idempotent across re-initialization", () => {
  const dir = makeTempDir("atlas-workspaces-reopen-");
  const dbPath = path.join(dir, "atlas.db");

  initializeDatabase(dbPath);
  initializeDatabase(dbPath);

  assert.strictEqual(listWorkspaces().length, 1);
});

test("lists the default first, then the rest alphabetically, with counts", () => {
  const db = freshDb();
  const zeta = createWorkspace({ name: "Zeta" });
  const alpha = createWorkspace({ name: "alpha" });
  const [defaultWorkspace] = listWorkspaces();

  insertRepository(db, { name: "a", path: "C:/repos/a", workspaceId: alpha.id });
  insertRepository(db, { name: "b", path: "C:/repos/b", workspaceId: alpha.id });
  insertRepository(db, {
    name: "c",
    path: "C:/repos/c",
    workspaceId: defaultWorkspace.id,
  });

  assert.deepStrictEqual(
    listWorkspaces().map((workspace) => [workspace.name, workspace.repositoryCount]),
    [
      [DEFAULT_WORKSPACE_NAME, 1],
      ["alpha", 2],
      ["Zeta", 0],
    ],
  );
  assert.strictEqual(zeta.repositoryCount, 0);
});

test("creates a workspace with trimmed fields", () => {
  freshDb();

  const workspace = createWorkspace({
    name: "  Work  ",
    description: "  Day job  ",
  });

  assert.strictEqual(workspace.name, "Work");
  assert.strictEqual(workspace.description, "Day job");
  assert.strictEqual(workspace.isDefault, false);
  assert.strictEqual(findWorkspace(workspace.id).name, "Work");
  // Numeric strings from the renderer resolve too.
  assert.strictEqual(findWorkspace(String(workspace.id)).name, "Work");
});

test("rejects blank, overlong, and duplicate workspace fields", () => {
  freshDb();
  createWorkspace({ name: "Work" });

  assert.throws(() => createWorkspace({ name: "   " }), /name is required/i);
  assert.throws(
    () => createWorkspace({ name: "x".repeat(MAX_WORKSPACE_NAME_LENGTH + 1) }),
    /characters or fewer/i,
  );
  assert.throws(
    () =>
      createWorkspace({
        name: "Big",
        description: "x".repeat(MAX_WORKSPACE_DESCRIPTION_LENGTH + 1),
      }),
    /characters or fewer/i,
  );

  // The unique index is case-insensitive, so the readable error must be too.
  assert.throws(() => createWorkspace({ name: "work" }), /already exists/i);
  assert.strictEqual(listWorkspaces().length, 2);
});

test("updates only the fields it is given", () => {
  freshDb();
  const workspace = createWorkspace({ name: "Work", description: "Day job" });

  const renamed = updateWorkspace(workspace.id, { name: "  Office  " });
  assert.strictEqual(renamed.name, "Office");
  assert.strictEqual(renamed.description, "Day job");

  const described = updateWorkspace(workspace.id, { description: "  Ships  " });
  assert.strictEqual(described.name, "Office");
  assert.strictEqual(described.description, "Ships");

  assert.throws(
    () => updateWorkspace(workspace.id, { name: DEFAULT_WORKSPACE_NAME }),
    /already exists/i,
  );
  assert.throws(() => updateWorkspace("missing", { name: "Nope" }), /not found/i);
  assert.throws(() => updateWorkspace(null, { name: "Nope" }), /not found/i);
});

test("moves a repository by external id and filters lists by workspace", () => {
  const db = freshDb();
  const work = createWorkspace({ name: "Work" });
  const [defaultWorkspace] = listWorkspaces();

  insertRepository(db, {
    name: "atlas",
    path: "C:/repos/atlas",
    externalId: "atlas-1",
    workspaceId: defaultWorkspace.id,
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

  assert.deepStrictEqual(moveRepositoryToWorkspace("atlas-1", work.id), {
    id: "atlas-1",
    workspaceId: work.id,
  });

  assert.deepStrictEqual(
    listRepositories(work.id).map((repository) => repository.name).sort(),
    ["atlas", "other"],
  );
  assert.deepStrictEqual(listRepositories(defaultWorkspace.id), []);

  assert.throws(() => moveRepositoryToWorkspace("missing", work.id), /Repository not found/i);
  assert.throws(() => moveRepositoryToWorkspace("atlas-1", 9999), /Workspace not found/i);
});

test("deleting a workspace moves its repositories to the default", () => {
  const db = freshDb();
  const work = createWorkspace({ name: "Work" });
  const [defaultWorkspace] = listWorkspaces();

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

  assert.deepStrictEqual(deleteWorkspace(work.id), {
    id: work.id,
    movedRepositoryCount: 1,
  });

  assert.strictEqual(findWorkspace(work.id), null);
  assert.deepStrictEqual(
    listWorkspaces().map((workspace) => workspace.name),
    [DEFAULT_WORKSPACE_NAME],
  );

  const [repository] = listRepositories(defaultWorkspace.id);
  assert.strictEqual(repository.name, "doomed");
  assert.strictEqual(repository.workspaceId, defaultWorkspace.id);
  // The indexed data itself is untouched: deleting a workspace is a filing
  // decision, not a repository delete.
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(repoId).n,
    1,
  );
});

test("the default workspace cannot be deleted", () => {
  freshDb();
  const [defaultWorkspace] = listWorkspaces();

  assert.throws(() => deleteWorkspace(defaultWorkspace.id), /cannot be deleted/i);
  assert.strictEqual(listWorkspaces().length, 1);
});

test("rejects deletes for unknown workspaces", () => {
  freshDb();

  assert.throws(() => deleteWorkspace("missing"), /not found/i);
  assert.throws(() => deleteWorkspace(null), /not found/i);
});

test("importing legacy repositories files them under the default workspace", () => {
  freshDb();
  const [defaultWorkspace] = listWorkspaces();

  importLegacyRepositories([
    { id: "old-1", name: "old", localPath: "C:/repos/old-1" },
  ]);

  assert.strictEqual(listRepositories()[0].workspaceId, defaultWorkspace.id);
});

test("indexing without workspace metadata falls back to the default", async () => {
  const db = freshDb();
  const [defaultWorkspace] = listWorkspaces();
  const root = makeTempDir("atlas-workspace-repo-");
  fs.writeFileSync(path.join(root, "a.js"), "let a;\n");

  const result = await new IndexerService().indexRepo(root, null, { name: "atlas" });

  assert.strictEqual(
    db.prepare("SELECT workspace_id FROM repos WHERE id = ?").get(result.repoId)
      .workspace_id,
    defaultWorkspace.id,
  );
});

test("a repository added after its workspace was deleted lands in the default", async () => {
  const db = freshDb();
  const work = createWorkspace({ name: "Work" });
  const [defaultWorkspace] = listWorkspaces();
  // repositories:add reads the active workspace up front, then clones. The
  // user deletes that workspace while the clone is still running.
  const capturedWorkspaceId = work.id;
  deleteWorkspace(work.id);

  const root = makeTempDir("atlas-workspace-deleted-");
  fs.writeFileSync(path.join(root, "a.js"), "let a;\n");

  const result = await new IndexerService().indexRepo(root, null, {
    name: "new",
    workspaceId: capturedWorkspaceId,
  });

  assert.strictEqual(
    db.prepare("SELECT workspace_id FROM repos WHERE id = ?").get(result.repoId)
      .workspace_id,
    defaultWorkspace.id,
  );
  // Most importantly, the repository is visible rather than filed under an id
  // that no longer exists.
  assert.deepStrictEqual(
    listRepositories(defaultWorkspace.id).map((repository) => repository.name),
    ["new"],
  );
});

test("indexing respects an explicit workspace without moving an existing one", async () => {
  const db = freshDb();
  const work = createWorkspace({ name: "Work" });
  const other = createWorkspace({ name: "Other" });
  const [defaultWorkspace] = listWorkspaces();
  const root = makeTempDir("atlas-workspace-explicit-");
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

  // A re-index from a caller without workspace context (the CLI or a sync)
  // must not silently move the repository back to the default.
  await indexer.indexRepo(root, null, { name: "atlas" });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);

  // Even an explicit workspace id must not move an existing row. A startup
  // backfill or sync captures the id before its long async work; a move the
  // user makes in the meantime must survive that re-index.
  await indexer.indexRepo(root, null, {
    name: "atlas",
    workspaceId: other.id,
  });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);

  await indexer.indexRepo(root, null, {
    name: "atlas",
    workspaceId: defaultWorkspace.id,
  });
  assert.strictEqual(workspaceIdOf(first.repoId), work.id);
});
