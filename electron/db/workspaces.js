const { getDb } = require("./schema");
const { resolveRepositoryRowId } = require("./repositories");

const MAX_WORKSPACE_NAME_LENGTH = 60;
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 200;

const WORKSPACE_COLUMNS = `
  w.id,
  w.name,
  w.description,
  w.is_default,
  w.created_at,
  (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repository_count
`;

function mapWorkspaceRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    isDefault: row.is_default === 1,
    createdAt: row.created_at ?? null,
    repositoryCount: row.repository_count ?? 0,
  };
}

function toWorkspaceId(workspaceId) {
  if (typeof workspaceId === "number" && Number.isInteger(workspaceId)) {
    return workspaceId;
  }

  if (typeof workspaceId === "string" && /^\d+$/.test(workspaceId)) {
    return Number(workspaceId);
  }

  return null;
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Workspace name is required.");
  }

  const trimmed = name.trim();

  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(
      `Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`,
    );
  }

  return trimmed;
}

function validateDescription(description) {
  if (description === undefined || description === null) return "";

  if (typeof description !== "string") {
    throw new Error("Invalid workspace description.");
  }

  const trimmed = description.trim();

  if (trimmed.length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
    throw new Error(
      `Workspace description must be ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters or fewer.`,
    );
  }

  return trimmed;
}

// Names are unique case-insensitively (the index enforces it too), so this
// check exists to produce a readable error instead of a SQLite constraint.
function assertNameAvailable(name, excludeId = null) {
  const row = getDb()
    .prepare(
      `SELECT id FROM workspaces
        WHERE name = ? COLLATE NOCASE AND id IS NOT ?
        LIMIT 1`,
    )
    .get(name, excludeId);

  if (row) {
    throw new Error(`A workspace named "${name}" already exists.`);
  }
}

// Default first, then alphabetical, so the switcher keeps a stable order and
// the workspace repositories fall back to is always at the top.
function listWorkspaces() {
  const rows = getDb()
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS}
         FROM workspaces w
        ORDER BY w.is_default DESC, w.name COLLATE NOCASE ASC`,
    )
    .all();

  return rows.map(mapWorkspaceRow);
}

function findWorkspace(workspaceId) {
  const id = toWorkspaceId(workspaceId);

  if (id === null) return null;

  return mapWorkspaceRow(
    getDb()
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces w WHERE w.id = ?`)
      .get(id),
  );
}

function createWorkspace({ name, description } = {}) {
  const trimmedName = validateName(name);
  const trimmedDescription = validateDescription(description);

  assertNameAvailable(trimmedName);

  const result = getDb()
    .prepare(
      `INSERT INTO workspaces (name, description, is_default, created_at)
       VALUES (?, ?, 0, ?)`,
    )
    .run(trimmedName, trimmedDescription, new Date().toISOString());

  return findWorkspace(Number(result.lastInsertRowid));
}

// A partial update: only the fields present are written, which keeps a rename
// from clearing a description the caller did not touch.
function updateWorkspace(workspaceId, patch = {}) {
  const id = toWorkspaceId(workspaceId);
  const existing = id === null ? null : findWorkspace(id);

  if (!existing) {
    throw new Error("Workspace not found.");
  }

  let name = existing.name;
  let description = existing.description;

  if ("name" in patch) {
    name = validateName(patch.name);
    assertNameAvailable(name, id);
  }

  if ("description" in patch) {
    description = validateDescription(patch.description);
  }

  getDb()
    .prepare("UPDATE workspaces SET name = ?, description = ? WHERE id = ?")
    .run(name, description, id);

  return findWorkspace(id);
}

// Deleting a workspace never deletes repositories: they move to the default
// workspace so every indexed repository stays reachable. The default workspace
// itself cannot be deleted, because it is the fallback the move relies on.
function deleteWorkspace(workspaceId) {
  const id = toWorkspaceId(workspaceId);
  const existing = id === null ? null : findWorkspace(id);

  if (!existing) {
    throw new Error("Workspace not found.");
  }

  if (existing.isDefault) {
    throw new Error("The default workspace cannot be deleted.");
  }

  const db = getDb();
  const defaultWorkspace = db
    .prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1")
    .get();

  // initializeDatabase guarantees a default workspace exists, so this is a
  // corrupted-database guard rather than a case the UI can trigger.
  if (!defaultWorkspace) {
    throw new Error("The default workspace is missing.");
  }

  const moveRepositories = db.prepare(
    "UPDATE repos SET workspace_id = ? WHERE workspace_id = ?",
  );
  const deleteRow = db.prepare("DELETE FROM workspaces WHERE id = ?");

  const runDelete = db.transaction(() => {
    const movedRepositoryCount = moveRepositories.run(
      defaultWorkspace.id,
      id,
    ).changes;

    deleteRow.run(id);

    return movedRepositoryCount;
  });

  return { id, movedRepositoryCount: runDelete() };
}

function moveRepositoryToWorkspace(repositoryId, workspaceId) {
  const rowId = resolveRepositoryRowId(repositoryId);

  if (rowId === null) {
    throw new Error("Repository not found.");
  }

  const workspace = findWorkspace(workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  getDb()
    .prepare("UPDATE repos SET workspace_id = ? WHERE id = ?")
    .run(workspace.id, rowId);

  return { id: repositoryId, workspaceId: workspace.id };
}

module.exports = {
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  listWorkspaces,
  findWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  moveRepositoryToWorkspace,
};
