const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { initializeDatabase, closeDatabase } = require("../electron/db/schema");
const { initializeSettings } = require("../electron/settings");
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

test.beforeEach(() => {
  for (const name of ENV_VARIABLES) delete process.env[name];
});

test.afterEach(() => {
  initializeSettings(null);
});

const EVENT = { sender: {} };

// Boots the main process against `userData` the way a launch does, so a test
// can quit (closing the singleton database) and launch again on the same data.
async function launch(userData) {
  closeDatabase();

  const { handlers, sentEvents } = await loadMain({ userData });
  const invoke = (channel, ...args) => handlers.get(channel)(EVENT, ...args);
  const db = initializeDatabase(
    path.join(userData, "atlas-data", "atlas.db"),
  );

  return { handlers, sentEvents, invoke, db };
}

function insertRepository(db, name, profileId) {
  db.prepare(
    "INSERT INTO repos (name, root_path, external_id, workspace_id) VALUES (?, ?, ?, ?)",
  ).run(name, path.join("C:", "repos", name), `${name}-id`, profileId);
}

function channelsOf(sentEvents) {
  return sentEvents.map((event) => event.channel);
}

test("main process exposes the profile IPC handlers", async () => {
  const { handlers } = await launch(makeTempDir("atlas-profiles-ipc-"));

  for (const channel of [
    "profiles:list",
    "profiles:create",
    "profiles:update",
    "profiles:switch",
    "profiles:remove",
    "repositories:move",
  ]) {
    assert.ok(handlers.has(channel), `expected ${channel}`);
  }

  // The old workspace channels are gone: one concept, not two.
  assert.ok(!handlers.has("workspaces:list"));
});

test("creates, renames and validates profiles with readable errors", async () => {
  const { invoke, sentEvents } = await launch(makeTempDir("atlas-profiles-crud-"));

  const created = await invoke("profiles:create", {
    name: "  Work  ",
    description: " Client projects ",
  });

  assert.strictEqual(created.name, "Work");
  assert.strictEqual(created.description, "Client projects");
  assert.ok(channelsOf(sentEvents).includes("profiles:changed"));

  await assert.rejects(
    () => invoke("profiles:create", { name: "work" }),
    /A profile named "work" already exists\./,
  );
  await assert.rejects(
    () => invoke("profiles:create", { name: "   " }),
    /Profile name is required\./,
  );
  await assert.rejects(
    () => invoke("profiles:create", { name: "x".repeat(61) }),
    /60 characters or fewer/,
  );

  const renamed = await invoke("profiles:update", {
    profileId: created.id,
    patch: { name: "Client work" },
  });

  assert.strictEqual(renamed.name, "Client work");
  assert.deepStrictEqual(
    (await invoke("profiles:list")).map((profile) => profile.name),
    ["Personal", "Client work"],
  );
});

test("switching profiles switches repositories and configuration together", async () => {
  const { invoke, sentEvents, db } = await launch(
    makeTempDir("atlas-profiles-switch-"),
  );

  const personal = (await invoke("profiles:list"))[0];
  const work = await invoke("profiles:create", { name: "Work" });

  insertRepository(db, "personal-repo", personal.id);
  insertRepository(db, "work-repo", work.id);

  await invoke("settings:set", {
    general: { theme: "light" },
    ai: { chatModel: "personal-model", apiKey: "personal-secret" },
  });

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((repository) => repository.name),
    ["personal-repo"],
  );

  sentEvents.length = 0;

  const switched = await invoke("profiles:switch", work.id);

  // The settings returned and pushed are the new profile's.
  assert.strictEqual(switched.profile.id, work.id);
  assert.strictEqual(switched.general.theme, "system");
  assert.strictEqual(switched.ai.chatModel, "");
  assert.strictEqual(switched.ai.hasApiKey, false);

  const pushed = sentEvents.find((event) => event.channel === "settings:changed");
  assert.strictEqual(pushed.payload.profile.id, work.id);
  assert.ok(channelsOf(sentEvents).includes("profiles:changed"));
  assert.ok(channelsOf(sentEvents).includes("repositories:changed"));

  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((repository) => repository.name),
    ["work-repo"],
  );

  await invoke("settings:set", {
    general: { theme: "dark" },
    ai: { apiKey: "work-secret" },
  });

  const back = await invoke("profiles:switch", personal.id);

  assert.strictEqual(back.general.theme, "light");
  assert.strictEqual(back.ai.chatModel, "personal-model");
  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((repository) => repository.name),
    ["personal-repo"],
  );

  await assert.rejects(() => invoke("profiles:switch", 9999), /Profile not found/);
});

test("no payload sent to the renderer ever contains an API key", async () => {
  const { invoke, sentEvents } = await launch(
    makeTempDir("atlas-profiles-secrets-"),
  );

  const work = await invoke("profiles:create", { name: "Work" });

  const results = [
    await invoke("settings:set", { ai: { apiKey: "personal-secret" } }),
    await invoke("profiles:switch", work.id),
    await invoke("settings:set", { ai: { apiKey: "work-secret" } }),
    await invoke("settings:get"),
    await invoke("profiles:list"),
    await invoke("repositories:list"),
  ];

  const everything = JSON.stringify([
    results,
    sentEvents.map((event) => event.payload ?? null),
  ]);

  assert.ok(!everything.includes("personal-secret"));
  assert.ok(!everything.includes("work-secret"));
  assert.strictEqual(results[3].ai.hasApiKey, true);
  assert.strictEqual(results[3].ai.apiKeySource, "settings");
});

test("the active profile and its settings are identical after a restart", async () => {
  const userData = makeTempDir("atlas-profiles-restart-");

  let app = await launch(userData);

  const personal = (await app.invoke("profiles:list"))[0];
  const work = await app.invoke("profiles:create", { name: "Work" });

  insertRepository(app.db, "personal-repo", personal.id);
  insertRepository(app.db, "work-repo", work.id);

  await app.invoke("settings:set", {
    general: { theme: "light", syncIntervalMinutes: 20 },
    ai: { apiKey: "personal-secret" },
  });
  await app.invoke("profiles:switch", work.id);
  await app.invoke("settings:set", {
    general: { theme: "dark", autoSync: false, syncIntervalMinutes: 60 },
    ai: { chatModel: "work-model", embedApiUrl: "https://example.com/embed" },
  });

  const before = await app.invoke("settings:get");

  // Quit and relaunch on the same data folder.
  app = await launch(userData);

  const after = await app.invoke("settings:get");

  assert.deepStrictEqual(after, before);
  assert.strictEqual(after.profile.id, work.id);
  assert.strictEqual(after.general.theme, "dark");
  assert.strictEqual(after.general.autoSync, false);
  assert.strictEqual(after.general.syncIntervalMinutes, 60);
  assert.strictEqual(after.ai.chatModel, "work-model");
  assert.deepStrictEqual(
    (await app.invoke("repositories:list")).map((repository) => repository.name),
    ["work-repo"],
  );

  // The other profile kept its own values, and its key.
  const restored = await app.invoke("profiles:switch", personal.id);

  assert.strictEqual(restored.general.theme, "light");
  assert.strictEqual(restored.general.syncIntervalMinutes, 20);
  assert.strictEqual(restored.ai.hasApiKey, true);
});

test("deleting the active profile falls back to the default and broadcasts", async () => {
  const userData = makeTempDir("atlas-profiles-delete-active-");
  let app = await launch(userData);

  const personal = (await app.invoke("profiles:list"))[0];
  const work = await app.invoke("profiles:create", { name: "Work" });

  insertRepository(app.db, "work-repo", work.id);

  await app.invoke("settings:set", { general: { theme: "light" } });
  await app.invoke("profiles:switch", work.id);
  await app.invoke("settings:set", {
    general: { theme: "dark" },
    ai: { apiKey: "work-secret" },
  });

  app.sentEvents.length = 0;

  const result = await app.invoke("profiles:remove", work.id);

  assert.strictEqual(result.movedRepositoryCount, 1);

  const pushed = app.sentEvents.find(
    (event) => event.channel === "settings:changed",
  );

  // The renderer is told about the default profile's settings, not the deleted
  // profile's, and the visible repositories moved with them.
  assert.strictEqual(pushed.payload.profile.id, personal.id);
  assert.strictEqual(pushed.payload.general.theme, "light");
  assert.strictEqual(pushed.payload.ai.hasApiKey, false);
  assert.ok(channelsOf(app.sentEvents).includes("profiles:changed"));
  assert.ok(channelsOf(app.sentEvents).includes("repositories:changed"));
  assert.deepStrictEqual(
    (await app.invoke("repositories:list")).map((repository) => repository.name),
    ["work-repo"],
  );

  // The fallback was persisted, not just resolved: a restart agrees.
  app = await launch(userData);

  assert.strictEqual((await app.invoke("settings:get")).profile.id, personal.id);
});

test("deleting an inactive profile leaves the active one untouched", async () => {
  const { invoke, sentEvents } = await launch(
    makeTempDir("atlas-profiles-delete-inactive-"),
  );

  const personal = (await invoke("profiles:list"))[0];
  const work = await invoke("profiles:create", { name: "Work" });

  sentEvents.length = 0;

  await invoke("profiles:remove", work.id);

  assert.strictEqual((await invoke("settings:get")).profile.id, personal.id);
  assert.ok(!channelsOf(sentEvents).includes("settings:changed"));
  assert.ok(channelsOf(sentEvents).includes("profiles:changed"));

  await assert.rejects(
    () => invoke("profiles:remove", personal.id),
    /default profile cannot be deleted/i,
  );
});

test("an existing install migrates on launch without losing anything", async () => {
  const userData = makeTempDir("atlas-profiles-upgrade-");
  const atlasRoot = path.join(userData, "atlas-data");
  const fs = require("node:fs");

  // The previous version's on-disk state: a database with a workspace and
  // repositories, and global settings in settings.json.
  const db = initializeDatabase(path.join(atlasRoot, "atlas.db"));
  const defaultId = db
    .prepare("SELECT id FROM workspaces WHERE is_default = 1")
    .get().id;
  const workId = Number(
    db
      .prepare(
        "INSERT INTO workspaces (name, description, is_default, created_at) VALUES ('Work', '', 0, ?)",
      )
      .run(new Date().toISOString()).lastInsertRowid,
  );

  insertRepository(db, "personal-repo", defaultId);
  insertRepository(db, "work-repo", workId);
  fs.writeFileSync(
    path.join(atlasRoot, "settings.json"),
    JSON.stringify({
      version: 1,
      ai: { chatModel: "legacy-model" },
      general: {
        theme: "dark",
        autoSync: false,
        syncIntervalMinutes: 25,
        activeWorkspaceId: workId,
      },
      apiKey: { value: "legacy-secret", encrypted: false },
    }),
  );

  const { invoke } = await launch(userData);

  const settings = await invoke("settings:get");

  assert.strictEqual(settings.profile.id, workId);
  assert.strictEqual(settings.general.theme, "dark");
  assert.strictEqual(settings.general.autoSync, false);
  assert.strictEqual(settings.general.syncIntervalMinutes, 25);
  assert.strictEqual(settings.ai.chatModel, "legacy-model");
  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((repository) => repository.name),
    ["work-repo"],
  );

  const switched = await invoke("profiles:switch", defaultId);

  assert.strictEqual(switched.ai.hasApiKey, true);
  assert.deepStrictEqual(
    (await invoke("repositories:list")).map((repository) => repository.name),
    ["personal-repo"],
  );
});
