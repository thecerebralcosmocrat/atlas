const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  initializeSettings,
  getPublicSettings,
  getResolvedSettings,
  updateSettings,
  DEFAULTS,
} = require("../electron/settings");
const { initializeDatabase } = require("../electron/db/schema");
const { listProfiles } = require("../electron/db/profiles");
const { loadMain } = require("./helpers/loadMain");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tempDirs");

test.after(cleanupTempDirs);

const ENV_VARIABLES = [
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_NIM_MODEL",
  "NVIDIA_NIM_API_URL",
  "NVIDIA_NIM_EMBED_MODEL",
  "NVIDIA_NIM_EMBED_API_URL",
];

function clearEnv() {
  for (const name of ENV_VARIABLES) {
    delete process.env[name];
  }
}

// Per-profile settings live in SQLite, so every case needs a database as well
// as the install-wide settings file.
function setup() {
  const dir = makeTempDir("atlas-settings-");
  const settingsPath = path.join(dir, "settings.json");

  initializeDatabase(path.join(dir, "atlas.db"));
  initializeSettings(settingsPath);

  return { dir, settingsPath };
}

test.afterEach(() => {
  clearEnv();
  initializeSettings(null);
});

test("falls back to defaults with no settings file", () => {
  setup();

  const settings = getPublicSettings();
  const [defaultProfile] = listProfiles();

  assert.strictEqual(settings.general.theme, "system");
  assert.strictEqual(settings.general.autoSync, true);
  assert.strictEqual(settings.general.syncIntervalMinutes, 5);
  // With no remembered choice the default profile is active.
  assert.strictEqual(settings.general.activeProfileId, defaultProfile.id);
  assert.strictEqual(settings.profile.id, defaultProfile.id);
  assert.strictEqual(settings.profile.isDefault, true);
  assert.strictEqual(settings.ai.apiKeySource, "none");
  assert.strictEqual(settings.ai.hasApiKey, false);
  assert.strictEqual(settings.ai.chatModel, "");
  assert.strictEqual(settings.ai.effective.chatModel, DEFAULTS.ai.chatModel);
  assert.strictEqual(
    settings.ai.effective.embedModel,
    DEFAULTS.ai.embedModel,
  );
});

test("persists general and AI overrides in the database", () => {
  setup();

  updateSettings({
    general: { theme: "dark", autoSync: false, syncIntervalMinutes: 15 },
    ai: { chatModel: "custom-model", chatApiUrl: "https://example.com/chat" },
  });

  const settings = getPublicSettings();

  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 15);
  assert.strictEqual(settings.ai.chatModel, "custom-model");
  assert.strictEqual(settings.ai.chatApiUrl, "https://example.com/chat");
});

test("stores an API key without exposing it in the renderer payload", () => {
  const { settingsPath } = setup();

  const publicSettings = updateSettings({ ai: { apiKey: "secret-key" } });

  assert.strictEqual(publicSettings.ai.apiKeySource, "settings");
  assert.strictEqual(publicSettings.ai.hasApiKey, true);
  assert.ok(!JSON.stringify(publicSettings).includes("secret-key"));
  assert.ok(!JSON.stringify(getPublicSettings()).includes("secret-key"));
  assert.strictEqual(getResolvedSettings().ai.apiKey, "secret-key");

  // The key lives in the profile's database row, not in the install-wide
  // settings file, which only remembers which profile was active.
  if (fs.existsSync(settingsPath)) {
    assert.ok(!fs.readFileSync(settingsPath, "utf8").includes("secret-key"));
  }
});

test("clearing the stored key falls back to the environment", () => {
  setup();
  updateSettings({ ai: { apiKey: "stored-key" } });

  process.env.NVIDIA_NIM_API_KEY = "env-key";

  const cleared = updateSettings({ ai: { apiKey: null } });

  assert.strictEqual(cleared.ai.apiKeySource, "environment");
  assert.strictEqual(cleared.ai.hasApiKey, true);
  assert.strictEqual(getResolvedSettings().ai.apiKey, "env-key");
});

test("saved values win over environment values, which win over defaults", () => {
  setup();
  process.env.NVIDIA_NIM_MODEL = "env-model";

  assert.strictEqual(getPublicSettings().ai.effective.chatModel, "env-model");

  updateSettings({ ai: { chatModel: "saved-model" } });

  assert.strictEqual(getPublicSettings().ai.effective.chatModel, "saved-model");
});

test("an empty AI field clears the override and resolves again", () => {
  setup();
  updateSettings({ ai: { chatModel: "saved-model" } });

  const settings = updateSettings({ ai: { chatModel: "" } });

  assert.strictEqual(settings.ai.chatModel, "");
  assert.strictEqual(settings.ai.effective.chatModel, DEFAULTS.ai.chatModel);
});

test("rejects invalid updates without changing the current settings", () => {
  setup();

  assert.throws(() => updateSettings({ general: { theme: "neon" } }), /Theme/);
  assert.throws(
    () => updateSettings({ general: { syncIntervalMinutes: 0 } }),
    /Sync interval/,
  );
  assert.throws(
    () => updateSettings({ general: { syncIntervalMinutes: 2.5 } }),
    /Sync interval/,
  );
  assert.throws(
    () => updateSettings({ general: { autoSync: "yes" } }),
    /Auto-sync/,
  );
  // Switching profiles is its own operation; a settings patch cannot do it.
  assert.throws(
    () => updateSettings({ general: { activeProfileId: 1 } }),
    /profile/i,
  );
  assert.throws(
    () => updateSettings({ ai: { chatApiUrl: "ftp://example.com" } }),
    /http/,
  );

  assert.strictEqual(getPublicSettings().general.theme, "system");
  assert.strictEqual(getPublicSettings().general.syncIntervalMinutes, 5);
});

test("a rejected update is all-or-nothing", () => {
  setup();

  assert.throws(
    () =>
      updateSettings({
        general: { theme: "dark" },
        ai: { chatApiUrl: "not a url" },
      }),
    /http/,
  );

  assert.strictEqual(getPublicSettings().general.theme, "system");
});

test("ignores a corrupt settings file", () => {
  const dir = makeTempDir("atlas-settings-corrupt-");
  const settingsPath = path.join(dir, "settings.json");

  initializeDatabase(path.join(dir, "atlas.db"));
  fs.writeFileSync(settingsPath, "{ not json");

  initializeSettings(settingsPath);

  assert.strictEqual(getPublicSettings().general.theme, "system");
});

test("main process exposes the settings IPC handlers", async () => {
  clearEnv();

  const userData = makeTempDir("atlas-settings-main-");
  const { handlers } = await loadMain({ userData });

  assert.ok(handlers.has("settings:get"));
  assert.ok(handlers.has("settings:set"));
  assert.ok(handlers.has("settings:test-connection"));
  assert.ok(handlers.has("settings:storage-info"));
  assert.ok(handlers.has("settings:open-storage"));

  const initial = await handlers.get("settings:get")();

  assert.strictEqual(initial.general.theme, "system");

  const updated = await handlers.get("settings:set")(
    { sender: {} },
    { general: { theme: "dark", syncIntervalMinutes: 10 } },
  );

  assert.strictEqual(updated.general.theme, "dark");
  assert.strictEqual(updated.general.syncIntervalMinutes, 10);

  // Per-profile settings live in the database in the app's data folder.
  assert.ok(fs.existsSync(path.join(userData, "atlas-data", "atlas.db")));
});
