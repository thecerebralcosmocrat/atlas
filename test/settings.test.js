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

function makeSettingsPath() {
  return path.join(makeTempDir("atlas-settings-"), "settings.json");
}

test.afterEach(() => {
  clearEnv();
  initializeSettings(null);
});

test("falls back to defaults with no settings file", () => {
  initializeSettings(makeSettingsPath());

  const settings = getPublicSettings();

  assert.strictEqual(settings.general.theme, "system");
  assert.strictEqual(settings.general.autoSync, true);
  assert.strictEqual(settings.general.syncIntervalMinutes, 5);
  // Null means "no explicit choice", which resolves to the default workspace.
  assert.strictEqual(settings.general.activeWorkspaceId, null);
  assert.strictEqual(settings.ai.apiKeySource, "none");
  assert.strictEqual(settings.ai.hasApiKey, false);
  assert.strictEqual(settings.ai.chatModel, "");
  assert.strictEqual(settings.ai.effective.chatModel, DEFAULTS.ai.chatModel);
  assert.strictEqual(
    settings.ai.effective.embedModel,
    DEFAULTS.ai.embedModel,
  );
});

test("persists general and AI overrides across reloads", () => {
  const filePath = makeSettingsPath();
  initializeSettings(filePath);

  updateSettings({
    general: {
      theme: "dark",
      autoSync: false,
      syncIntervalMinutes: 15,
      activeWorkspaceId: 7,
    },
    ai: { chatModel: "custom-model", chatApiUrl: "https://example.com/chat" },
  });

  initializeSettings(filePath);

  const settings = getPublicSettings();

  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 15);
  assert.strictEqual(settings.general.activeWorkspaceId, 7);
  assert.strictEqual(settings.ai.chatModel, "custom-model");
  assert.strictEqual(settings.ai.chatApiUrl, "https://example.com/chat");
});

test("stores an API key without exposing it in the renderer payload", () => {
  const filePath = makeSettingsPath();
  initializeSettings(filePath);

  const publicSettings = updateSettings({ ai: { apiKey: "secret-key" } });

  assert.strictEqual(publicSettings.ai.apiKeySource, "settings");
  assert.strictEqual(publicSettings.ai.hasApiKey, true);
  assert.ok(!JSON.stringify(publicSettings).includes("secret-key"));
  assert.strictEqual(getResolvedSettings().ai.apiKey, "secret-key");

  // The file holds the key (encrypted when safeStorage is available, plain
  // under the test runner), and the public shape never carries it.
  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.ok(onDisk.includes("apiKey"));
});

test("clearing the stored key falls back to the environment", () => {
  initializeSettings(makeSettingsPath());
  updateSettings({ ai: { apiKey: "stored-key" } });

  process.env.NVIDIA_NIM_API_KEY = "env-key";

  const cleared = updateSettings({ ai: { apiKey: null } });

  assert.strictEqual(cleared.ai.apiKeySource, "environment");
  assert.strictEqual(cleared.ai.hasApiKey, true);
  assert.strictEqual(getResolvedSettings().ai.apiKey, "env-key");
});

test("saved values win over environment values, which win over defaults", () => {
  initializeSettings(makeSettingsPath());
  process.env.NVIDIA_NIM_MODEL = "env-model";

  assert.strictEqual(getPublicSettings().ai.effective.chatModel, "env-model");

  updateSettings({ ai: { chatModel: "saved-model" } });

  assert.strictEqual(getPublicSettings().ai.effective.chatModel, "saved-model");
});

test("an empty AI field clears the override and resolves again", () => {
  initializeSettings(makeSettingsPath());
  updateSettings({ ai: { chatModel: "saved-model" } });

  const settings = updateSettings({ ai: { chatModel: "" } });

  assert.strictEqual(settings.ai.chatModel, "");
  assert.strictEqual(settings.ai.effective.chatModel, DEFAULTS.ai.chatModel);
});

test("rejects invalid updates without changing the current settings", () => {
  initializeSettings(makeSettingsPath());

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
  assert.throws(
    () => updateSettings({ general: { activeWorkspaceId: 1.5 } }),
    /workspace/i,
  );
  assert.throws(
    () => updateSettings({ general: { activeWorkspaceId: 0 } }),
    /workspace/i,
  );
  assert.throws(
    () => updateSettings({ general: { activeWorkspaceId: "2" } }),
    /workspace/i,
  );
  assert.throws(
    () => updateSettings({ ai: { chatApiUrl: "ftp://example.com" } }),
    /http/,
  );

  assert.strictEqual(getPublicSettings().general.theme, "system");
  assert.strictEqual(getPublicSettings().general.syncIntervalMinutes, 5);
  assert.strictEqual(getPublicSettings().general.activeWorkspaceId, null);

  // Clearing the explicit choice is valid and falls back to the default.
  assert.strictEqual(
    updateSettings({ general: { activeWorkspaceId: null } }).general
      .activeWorkspaceId,
    null,
  );
});

test("ignores a corrupt settings file", () => {
  const filePath = makeSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ not json");

  initializeSettings(filePath);

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

  // Settings live beside the database in the app's data folder.
  const settingsPath = path.join(userData, "atlas-data", "settings.json");

  assert.ok(fs.existsSync(settingsPath));
});
