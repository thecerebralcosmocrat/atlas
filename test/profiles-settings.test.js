const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { initializeDatabase, closeDatabase, getDb } = require("../electron/db/schema");
const {
  listProfiles,
  createProfile,
  deleteProfile,
} = require("../electron/db/profiles");
const {
  initializeSettings,
  getPublicSettings,
  getResolvedSettings,
  getActiveProfileId,
  setActiveProfile,
  updateSettings,
} = require("../electron/settings");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

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

function setup() {
  const dir = makeTempDir("atlas-profile-settings-");
  const paths = {
    dbPath: path.join(dir, "atlas.db"),
    settingsPath: path.join(dir, "settings.json"),
  };

  initializeDatabase(paths.dbPath);
  initializeSettings(paths.settingsPath);

  return paths;
}

// Stands in for quitting and relaunching: the database and settings are closed
// and loaded again from disk, exactly as app startup does.
function restart({ dbPath, settingsPath }) {
  closeDatabase();
  initializeDatabase(dbPath);
  initializeSettings(settingsPath);
}

function defaultProfileId() {
  return listProfiles().find((profile) => profile.isDefault).id;
}

test("each profile keeps its own theme, sync policy, AI config and key", () => {
  setup();

  const personal = defaultProfileId();
  const work = createProfile({ name: "Work" });

  updateSettings({
    general: { theme: "light", autoSync: true, syncIntervalMinutes: 30 },
    ai: { chatModel: "personal-model", apiKey: "personal-key" },
  });

  setActiveProfile(work.id);

  // A new profile starts from defaults and does not inherit the key.
  let settings = getPublicSettings();
  assert.strictEqual(settings.profile.name, "Work");
  assert.strictEqual(settings.general.theme, "system");
  assert.strictEqual(settings.general.syncIntervalMinutes, 5);
  assert.strictEqual(settings.ai.chatModel, "");
  assert.strictEqual(settings.ai.hasApiKey, false);
  assert.strictEqual(getResolvedSettings().ai.apiKey, null);

  updateSettings({
    general: { theme: "dark", autoSync: false, syncIntervalMinutes: 90 },
    ai: { chatModel: "work-model", apiKey: "work-key" },
  });

  assert.strictEqual(getResolvedSettings().ai.apiKey, "work-key");

  setActiveProfile(personal);

  settings = getPublicSettings();
  assert.strictEqual(settings.general.theme, "light");
  assert.strictEqual(settings.general.syncIntervalMinutes, 30);
  assert.strictEqual(settings.ai.chatModel, "personal-model");
  assert.strictEqual(getResolvedSettings().ai.apiKey, "personal-key");

  setActiveProfile(work.id);

  settings = getPublicSettings();
  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 90);
  assert.strictEqual(settings.ai.chatModel, "work-model");
  assert.strictEqual(getResolvedSettings().ai.apiKey, "work-key");
});

test("the renderer payload never carries a key for any profile", () => {
  setup();

  const work = createProfile({ name: "Work" });

  updateSettings({ ai: { apiKey: "personal-secret" } });
  setActiveProfile(work.id);
  updateSettings({ ai: { apiKey: "work-secret" } });

  for (const payload of [
    getPublicSettings(),
    setActiveProfile(defaultProfileId()),
    updateSettings({ ai: { chatModel: "m" } }),
  ]) {
    const serialized = JSON.stringify(payload);

    assert.ok(!serialized.includes("personal-secret"));
    assert.ok(!serialized.includes("work-secret"));
    assert.strictEqual(payload.ai.hasApiKey, true);
    assert.strictEqual(payload.ai.apiKeySource, "settings");
    assert.ok(!("apiKey" in payload.ai));
  }
});

test("clearing one profile's key leaves the other profile's key alone", () => {
  setup();

  const personal = defaultProfileId();
  const work = createProfile({ name: "Work" });

  updateSettings({ ai: { apiKey: "personal-key" } });
  setActiveProfile(work.id);
  updateSettings({ ai: { apiKey: "work-key" } });
  updateSettings({ ai: { apiKey: null } });

  assert.strictEqual(getPublicSettings().ai.hasApiKey, false);

  setActiveProfile(personal);

  assert.strictEqual(getResolvedSettings().ai.apiKey, "personal-key");
});

test("the active profile and every profile's settings survive a restart", () => {
  const paths = setup();

  const work = createProfile({ name: "Work" });

  updateSettings({ general: { theme: "light" }, ai: { apiKey: "personal-key" } });
  setActiveProfile(work.id);
  updateSettings({
    general: { theme: "dark", autoSync: false, syncIntervalMinutes: 45 },
    ai: {
      chatModel: "work-model",
      embedApiUrl: "https://example.com/embed",
      apiKey: "work-key",
    },
  });

  restart(paths);

  assert.strictEqual(getActiveProfileId(), work.id);

  let settings = getPublicSettings();
  assert.strictEqual(settings.profile.name, "Work");
  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 45);
  assert.strictEqual(settings.ai.chatModel, "work-model");
  assert.strictEqual(settings.ai.embedApiUrl, "https://example.com/embed");
  assert.strictEqual(getResolvedSettings().ai.apiKey, "work-key");

  setActiveProfile(defaultProfileId());
  restart(paths);

  settings = getPublicSettings();
  assert.strictEqual(settings.profile.isDefault, true);
  assert.strictEqual(settings.general.theme, "light");
  assert.strictEqual(getResolvedSettings().ai.apiKey, "personal-key");
});

test("a stale remembered profile id falls back to the default", () => {
  const paths = setup();

  fs.writeFileSync(
    paths.settingsPath,
    JSON.stringify({ version: 2, activeProfileId: 9999 }),
  );
  restart(paths);

  assert.strictEqual(getActiveProfileId(), defaultProfileId());
  assert.strictEqual(getPublicSettings().profile.isDefault, true);
});

test("switching validates the target profile", () => {
  setup();

  assert.throws(() => setActiveProfile(9999), /Profile not found/);
  assert.throws(() => setActiveProfile("2"), /Invalid profile/);
  assert.throws(() => setActiveProfile(0), /Invalid profile/);
  assert.strictEqual(getActiveProfileId(), defaultProfileId());

  // Null clears the explicit choice and resolves to the default.
  const work = createProfile({ name: "Work" });
  setActiveProfile(work.id);
  setActiveProfile(null);

  assert.strictEqual(getActiveProfileId(), defaultProfileId());
});

test("deleting a profile removes its settings and key and falls back", () => {
  setup();

  const personal = defaultProfileId();
  const work = createProfile({ name: "Work" });

  updateSettings({ general: { theme: "light" } });
  setActiveProfile(work.id);
  updateSettings({ ai: { apiKey: "work-secret" }, general: { theme: "dark" } });

  const countRows = () =>
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM profile_settings WHERE profile_id = ?")
      .get(work.id).n;

  assert.strictEqual(countRows(), 1);

  deleteProfile(work.id);

  // The selection still points at the deleted row, so reads resolve to the
  // default profile and its own settings, never the deleted profile's.
  assert.strictEqual(countRows(), 0);
  assert.strictEqual(getActiveProfileId(), personal);
  assert.strictEqual(getPublicSettings().general.theme, "light");
  assert.strictEqual(getPublicSettings().ai.hasApiKey, false);
  assert.ok(
    !JSON.stringify(
      getDb().prepare("SELECT * FROM profile_settings").all(),
    ).includes("work-secret"),
  );
});

test("a new profile reusing a deleted profile's name starts clean", () => {
  setup();

  const first = createProfile({ name: "Work" });

  setActiveProfile(first.id);
  updateSettings({ ai: { apiKey: "old-secret" }, general: { theme: "dark" } });
  setActiveProfile(defaultProfileId());
  deleteProfile(first.id);

  const second = createProfile({ name: "Work" });

  setActiveProfile(second.id);

  assert.strictEqual(getPublicSettings().general.theme, "system");
  assert.strictEqual(getPublicSettings().ai.hasApiKey, false);
});

test("migrates version 1 global settings into the existing profiles", () => {
  const dir = makeTempDir("atlas-profile-migrate-");
  const dbPath = path.join(dir, "atlas.db");
  const settingsPath = path.join(dir, "settings.json");

  // An install from before profiles: one default workspace, one extra
  // workspace, repositories filed under both, and global settings on disk.
  const db = initializeDatabase(dbPath);
  const work = createProfile({ name: "Work" });
  const personal = defaultProfileId();

  db.prepare(
    "INSERT INTO repos (name, root_path, workspace_id) VALUES (?, ?, ?)",
  ).run("a", path.join(dir, "a"), personal);
  db.prepare(
    "INSERT INTO repos (name, root_path, workspace_id) VALUES (?, ?, ?)",
  ).run("b", path.join(dir, "b"), work.id);

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      version: 1,
      ai: {
        chatModel: "legacy-model",
        chatApiUrl: "https://example.com/chat",
        embedModel: "",
        embedApiUrl: "",
      },
      general: {
        theme: "dark",
        autoSync: false,
        syncIntervalMinutes: 15,
        activeWorkspaceId: work.id,
      },
      apiKey: { value: "legacy-secret", encrypted: false },
    }),
  );

  initializeSettings(settingsPath);

  // The remembered workspace becomes the remembered profile.
  assert.strictEqual(getActiveProfileId(), work.id);

  // Behavior is unchanged on the profile the user was in: theme, sync and
  // model choices carried over to every profile that existed.
  let settings = getPublicSettings();
  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 15);
  assert.strictEqual(settings.ai.chatModel, "legacy-model");
  assert.strictEqual(settings.ai.chatApiUrl, "https://example.com/chat");

  // The old key is copied to the default profile only.
  assert.strictEqual(settings.ai.hasApiKey, false);
  setActiveProfile(personal);
  settings = getPublicSettings();
  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.ai.hasApiKey, true);
  assert.strictEqual(getResolvedSettings().ai.apiKey, "legacy-secret");

  // Repositories and their scoping are untouched.
  const scopes = db
    .prepare("SELECT name, workspace_id FROM repos ORDER BY name")
    .all();
  assert.deepStrictEqual(scopes, [
    { name: "a", workspace_id: personal },
    { name: "b", workspace_id: work.id },
  ]);

  // The settings file no longer holds per-profile values or the secret.
  const rewritten = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.strictEqual(rewritten.version, 2);
  assert.strictEqual(rewritten.activeProfileId, personal);
  assert.ok(!("ai" in rewritten));
  assert.ok(!("apiKey" in rewritten));
  assert.ok(!fs.readFileSync(settingsPath, "utf8").includes("legacy-secret"));

  // A profile created after the upgrade gets defaults, not the old values.
  const later = createProfile({ name: "Later" });
  setActiveProfile(later.id);
  assert.strictEqual(getPublicSettings().general.theme, "system");
  assert.strictEqual(getPublicSettings().ai.hasApiKey, false);
});

test("migration runs once and never overwrites saved profile settings", () => {
  const dir = makeTempDir("atlas-profile-migrate-once-");
  const paths = {
    dbPath: path.join(dir, "atlas.db"),
    settingsPath: path.join(dir, "settings.json"),
  };

  initializeDatabase(paths.dbPath);
  fs.writeFileSync(
    paths.settingsPath,
    JSON.stringify({ version: 1, general: { theme: "dark" } }),
  );
  initializeSettings(paths.settingsPath);

  updateSettings({ general: { theme: "light" } });
  restart(paths);

  assert.strictEqual(getPublicSettings().general.theme, "light");

  // Even if an old file reappears (a restored backup, say), saved profile
  // settings win and the file is rewritten without the old values.
  fs.writeFileSync(
    paths.settingsPath,
    JSON.stringify({ version: 1, general: { theme: "dark" } }),
  );
  restart(paths);

  assert.strictEqual(getPublicSettings().general.theme, "light");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(paths.settingsPath, "utf8")).version,
    2,
  );
});

test("recovers if the app stopped between the database and file steps", () => {
  const dir = makeTempDir("atlas-profile-migrate-crash-");
  const paths = {
    dbPath: path.join(dir, "atlas.db"),
    settingsPath: path.join(dir, "settings.json"),
  };
  const legacyFile = JSON.stringify({
    version: 1,
    general: { theme: "dark" },
    apiKey: { value: "legacy-secret", encrypted: false },
  });

  initializeDatabase(paths.dbPath);
  fs.writeFileSync(paths.settingsPath, legacyFile);
  initializeSettings(paths.settingsPath);

  // Simulate the crash: rows were committed but the old file is still there.
  fs.writeFileSync(paths.settingsPath, legacyFile);
  restart(paths);

  assert.strictEqual(getPublicSettings().general.theme, "dark");
  assert.strictEqual(getResolvedSettings().ai.apiKey, "legacy-secret");
  assert.ok(!fs.readFileSync(paths.settingsPath, "utf8").includes("legacy-secret"));
});

test("a version 1 file with only a workspace selection keeps that selection", () => {
  const dir = makeTempDir("atlas-profile-migrate-selection-");
  const settingsPath = path.join(dir, "settings.json");

  initializeDatabase(path.join(dir, "atlas.db"));
  const work = createProfile({ name: "Work" });

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ version: 1, general: { activeWorkspaceId: work.id } }),
  );
  initializeSettings(settingsPath);

  assert.strictEqual(getActiveProfileId(), work.id);
});
