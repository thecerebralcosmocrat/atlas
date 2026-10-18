const { getDb } = require("./schema");
const { resolveRepositoryRowId } = require("./repositories");

const MAX_PROFILE_NAME_LENGTH = 60;
const MAX_PROFILE_DESCRIPTION_LENGTH = 200;

const PROFILE_COLUMNS = `
  w.id,
  w.name,
  w.description,
  w.is_default,
  w.created_at,
  (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repository_count
`;

function mapProfileRow(row) {
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

function toProfileId(profileId) {
  if (typeof profileId === "number" && Number.isInteger(profileId)) {
    return profileId;
  }

  if (typeof profileId === "string" && /^\d+$/.test(profileId)) {
    return Number(profileId);
  }

  return null;
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Profile name is required.");
  }

  const trimmed = name.trim();

  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(
      `Profile name must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.`,
    );
  }

  return trimmed;
}

function validateDescription(description) {
  if (description === undefined || description === null) return "";

  if (typeof description !== "string") {
    throw new Error("Invalid profile description.");
  }

  const trimmed = description.trim();

  if (trimmed.length > MAX_PROFILE_DESCRIPTION_LENGTH) {
    throw new Error(
      `Profile description must be ${MAX_PROFILE_DESCRIPTION_LENGTH} characters or fewer.`,
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
    throw new Error(`A profile named "${name}" already exists.`);
  }
}

// Default first, then alphabetical, so the switcher keeps a stable order and
// the profile repositories fall back to is always at the top.
function listProfiles() {
  const rows = getDb()
    .prepare(
      `SELECT ${PROFILE_COLUMNS}
         FROM workspaces w
        ORDER BY w.is_default DESC, w.name COLLATE NOCASE ASC`,
    )
    .all();

  return rows.map(mapProfileRow);
}

function findProfile(profileId) {
  const id = toProfileId(profileId);

  if (id === null) return null;

  return mapProfileRow(
    getDb()
      .prepare(`SELECT ${PROFILE_COLUMNS} FROM workspaces w WHERE w.id = ?`)
      .get(id),
  );
}

function createProfile({ name, description } = {}) {
  const trimmedName = validateName(name);
  const trimmedDescription = validateDescription(description);

  assertNameAvailable(trimmedName);

  const result = getDb()
    .prepare(
      `INSERT INTO workspaces (name, description, is_default, created_at)
       VALUES (?, ?, 0, ?)`,
    )
    .run(trimmedName, trimmedDescription, new Date().toISOString());

  return findProfile(Number(result.lastInsertRowid));
}

// A partial update: only the fields present are written, which keeps a rename
// from clearing a description the caller did not touch.
function updateProfile(profileId, patch = {}) {
  const id = toProfileId(profileId);
  const existing = id === null ? null : findProfile(id);

  if (!existing) {
    throw new Error("Profile not found.");
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

  return findProfile(id);
}

// Deleting a profile never deletes repositories: they move to the default
// profile so every indexed repository stays reachable. The default profile
// itself cannot be deleted, because it is the fallback the move relies on.
function deleteProfile(profileId) {
  const id = toProfileId(profileId);
  const existing = id === null ? null : findProfile(id);

  if (!existing) {
    throw new Error("Profile not found.");
  }

  if (existing.isDefault) {
    throw new Error("The default profile cannot be deleted.");
  }

  const db = getDb();
  const defaultProfile = db
    .prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1")
    .get();

  // initializeDatabase guarantees a default profile exists, so this is a
  // corrupted-database guard rather than a case the UI can trigger.
  if (!defaultProfile) {
    throw new Error("The default profile is missing.");
  }

  const moveRepositories = db.prepare(
    "UPDATE repos SET workspace_id = ? WHERE workspace_id = ?",
  );
  const deleteRow = db.prepare("DELETE FROM workspaces WHERE id = ?");
  // The profile's settings row holds its encrypted API key. It is removed with
  // the profile rather than archived, so a deleted profile leaves no secret
  // behind and the key is never inherited by the default profile.
  const deleteSettings = db.prepare(
    "DELETE FROM profile_settings WHERE profile_id = ?",
  );

  const runDelete = db.transaction(() => {
    const movedRepositoryCount = moveRepositories.run(
      defaultProfile.id,
      id,
    ).changes;

    deleteSettings.run(id);
    deleteRow.run(id);

    return movedRepositoryCount;
  });

  return { id, movedRepositoryCount: runDelete() };
}

function moveRepositoryToProfile(repositoryId, profileId) {
  const rowId = resolveRepositoryRowId(repositoryId);

  if (rowId === null) {
    throw new Error("Repository not found.");
  }

  const profile = findProfile(profileId);

  if (!profile) {
    throw new Error("Profile not found.");
  }

  getDb()
    .prepare("UPDATE repos SET workspace_id = ? WHERE id = ?")
    .run(profile.id, rowId);

  return { id: repositoryId, profileId: profile.id };
}

// The default profile is the fallback for everything: deleted selections, stale
// ids in settings.json, and the home of repositories from deleted profiles.
function getDefaultProfileId() {
  const row = getDb()
    .prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1")
    .get();

  return row ? row.id : null;
}

// Verifies a remembered selection. A stored id can outlive its row (the profile
// was deleted, or the index was rebuilt), so every read goes through this and
// falls back to the default profile instead of showing an empty sidebar.
function resolveProfileId(storedId) {
  if (storedId !== null && storedId !== undefined && findProfile(storedId)) {
    return toProfileId(storedId);
  }

  return getDefaultProfileId();
}

module.exports = {
  getDefaultProfileId,
  resolveProfileId,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  listProfiles,
  findProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  moveRepositoryToProfile,
};
