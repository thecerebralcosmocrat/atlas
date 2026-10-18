const fs = require("node:fs");
const path = require("node:path");

const { getDb } = require("./db/schema");
const {
  findProfile,
  getDefaultProfileId,
  resolveProfileId,
} = require("./db/profiles");

// Settings are split by who owns them.
//
// Per profile (SQLite, `profile_settings`, keyed by the profile's row id):
// appearance, sync policy and the AI provider configuration including the
// encrypted API key. A profile switch therefore changes configuration together
// with the repositories the sidebar shows, and two profiles can use different
// keys without either ever being handed to the other.
//
// Per install (`settings.json`): which profile was active last. This is
// deliberately a tiny file outside the index so the selection survives even if
// the database is rebuilt, and it is readable before the database exists.
// Future install-wide options (data path, update behavior) belong here too.
//
// `electron-store` is ESM-only and the main process is CommonJS, so a tiny
// atomic writer does the job instead.

// Version 1 held theme, sync, AI config and the key for the whole install.
// Version 2 holds only install-wide values; a version 1 file is migrated into
// the default profile once and rewritten without the per-profile fields.
const SETTINGS_VERSION = 2;

const THEMES = new Set(["light", "dark", "system"]);
const MIN_SYNC_INTERVAL_MINUTES = 1;
const MAX_SYNC_INTERVAL_MINUTES = 120;
const MAX_MODEL_LENGTH = 200;
const MAX_URL_LENGTH = 500;
const MAX_API_KEY_LENGTH = 500;
const AI_FIELDS = ["chatModel", "chatApiUrl", "embedModel", "embedApiUrl"];

const AI_COLUMNS = {
  chatModel: "chat_model",
  chatApiUrl: "chat_api_url",
  embedModel: "embed_model",
  embedApiUrl: "embed_api_url",
};

const DEFAULTS = Object.freeze({
  ai: {
    chatModel: "nvidia/nemotron-3-super-120b-a12b",
    chatApiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    embedModel: "nvidia/nemotron-3-embed-1b",
    embedApiUrl: "https://integrate.api.nvidia.com/v1/embeddings",
  },
  general: {
    theme: "system",
    autoSync: true,
    syncIntervalMinutes: 5,
  },
});

// Environment variables remain an install-wide fallback so existing `.env`
// workflows keep working. A value saved in a profile wins, and the renderer is
// told when the effective key comes from the environment (`apiKeySource`), so
// a shared key is never silent.
const ENV_NAMES = {
  apiKey: "NVIDIA_NIM_API_KEY",
  chatModel: "NVIDIA_NIM_MODEL",
  chatApiUrl: "NVIDIA_NIM_API_URL",
  embedModel: "NVIDIA_NIM_EMBED_MODEL",
  embedApiUrl: "NVIDIA_NIM_EMBED_API_URL",
};

let settingsFilePath = null;
// Install-wide state. `activeProfileId` is the remembered selection; it can be
// stale, so it is only ever read through getActiveProfileId().
let install = createEmptyInstallSettings();
// Per-profile values found in a version 1 settings file, waiting to be copied
// into the default profile. Null once migrated (or when there was nothing).
let legacy = null;

function createEmptyInstallSettings() {
  return { activeProfileId: null };
}

function createEmptyProfileSettings() {
  return {
    ai: { chatModel: "", chatApiUrl: "", embedModel: "", embedApiUrl: "" },
    general: { ...DEFAULTS.general },
    // Either null or { value, encrypted }. `value` is base64 when encrypted.
    apiKey: null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// `require("electron")` outside a real Electron runtime (the test harness runs
// with ELECTRON_RUN_AS_NODE) resolves to the binary path, not the API object,
// so this stays defensive and optional.
function getSafeStorage() {
  try {
    const electron = require("electron");
    return electron?.safeStorage ?? null;
  } catch {
    return null;
  }
}

function encryptApiKey(apiKey) {
  const safeStorage = getSafeStorage();

  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      encrypted: true,
      value: safeStorage.encryptString(apiKey).toString("base64"),
    };
  }

  // Encrypted storage is unavailable (for example under the test runner). The
  // key still works; it is just stored as plain text in the user's data folder.
  return { encrypted: false, value: apiKey };
}

function decryptApiKey(record) {
  if (!record || typeof record.value !== "string" || !record.value) return null;

  if (!record.encrypted) return record.value;

  const safeStorage = getSafeStorage();

  if (!safeStorage?.isEncryptionAvailable?.()) return null;

  try {
    return safeStorage.decryptString(Buffer.from(record.value, "base64")) || null;
  } catch {
    // A database copied from another machine or user account cannot be
    // decrypted here. Treat it as unset rather than crashing on every launch.
    return null;
  }
}

function isValidSyncInterval(value) {
  return (
    Number.isInteger(value) &&
    value >= MIN_SYNC_INTERVAL_MINUTES &&
    value <= MAX_SYNC_INTERVAL_MINUTES
  );
}

function isValidProfileId(value) {
  return Number.isInteger(value) && value > 0;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install-wide settings file
// ---------------------------------------------------------------------------

// Pulls the per-profile values out of a version 1 file. Unknown and malformed
// values fall back to their defaults, exactly as the old loader did.
function normalizeLegacySettings(value) {
  const next = createEmptyProfileSettings();
  const ai = value.ai && typeof value.ai === "object" ? value.ai : {};

  for (const field of AI_FIELDS) {
    if (typeof ai[field] === "string" && ai[field].trim()) {
      next.ai[field] = ai[field].trim();
    }
  }

  const general =
    value.general && typeof value.general === "object" ? value.general : {};

  if (THEMES.has(general.theme)) next.general.theme = general.theme;
  if (typeof general.autoSync === "boolean") {
    next.general.autoSync = general.autoSync;
  }
  if (isValidSyncInterval(general.syncIntervalMinutes)) {
    next.general.syncIntervalMinutes = general.syncIntervalMinutes;
  }

  if (
    value.apiKey &&
    typeof value.apiKey === "object" &&
    typeof value.apiKey.value === "string" &&
    value.apiKey.value
  ) {
    next.apiKey = {
      value: value.apiKey.value,
      encrypted: value.apiKey.encrypted === true,
    };
  }

  return next;
}

// A corrupt or partially written file must never stop the app from starting.
function parseInstallFile(value) {
  const parsed = { install: createEmptyInstallSettings(), legacy: null };

  if (!value || typeof value !== "object") return parsed;

  const general =
    value.general && typeof value.general === "object" ? value.general : {};

  if (isValidProfileId(value.activeProfileId)) {
    parsed.install.activeProfileId = value.activeProfileId;
  } else if (isValidProfileId(general.activeWorkspaceId)) {
    // Version 1 called the selection `general.activeWorkspaceId`. Workspace
    // ids are profile ids, so the selection carries over unchanged.
    parsed.install.activeProfileId = general.activeWorkspaceId;
  }

  const isLegacyFile = !(
    Number.isInteger(value.version) && value.version >= SETTINGS_VERSION
  );

  if (isLegacyFile && (value.ai || value.general || value.apiKey)) {
    parsed.legacy = normalizeLegacySettings(value);
  }

  return parsed;
}

function readInstallFile() {
  if (!settingsFilePath) return { install: createEmptyInstallSettings(), legacy: null };

  let contents;

  try {
    contents = fs.readFileSync(settingsFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { install: createEmptyInstallSettings(), legacy: null };
    }
    throw error;
  }

  try {
    return parseInstallFile(JSON.parse(contents));
  } catch (error) {
    console.warn("Ignoring unreadable settings file:", error.message);
    return { install: createEmptyInstallSettings(), legacy: null };
  }
}

function writeInstallFile(next) {
  if (!settingsFilePath) {
    throw new Error("Settings storage has not been initialized.");
  }

  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });

  const payload = {
    version: SETTINGS_VERSION,
    activeProfileId: next.activeProfileId,
  };
  const tempPath = `${settingsFilePath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    // Rename is atomic, so a crash mid-write leaves the previous settings
    // intact rather than a truncated JSON file.
    fs.renameSync(tempPath, settingsFilePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Per-profile settings (SQLite)
// ---------------------------------------------------------------------------

function rowToStored(row) {
  const stored = createEmptyProfileSettings();

  if (!row) return stored;

  for (const field of AI_FIELDS) {
    stored.ai[field] = row[AI_COLUMNS[field]] ?? "";
  }

  if (THEMES.has(row.theme)) stored.general.theme = row.theme;
  stored.general.autoSync = row.auto_sync === 1;
  if (isValidSyncInterval(row.sync_interval_minutes)) {
    stored.general.syncIntervalMinutes = row.sync_interval_minutes;
  }

  if (typeof row.api_key_value === "string" && row.api_key_value) {
    stored.apiKey = {
      value: row.api_key_value,
      encrypted: row.api_key_encrypted === 1,
    };
  }

  return stored;
}

function writeProfileRow(profileId, stored) {
  getDb()
    .prepare(
      `INSERT INTO profile_settings (
         profile_id, theme, auto_sync, sync_interval_minutes,
         chat_model, chat_api_url, embed_model, embed_api_url,
         api_key_value, api_key_encrypted, updated_at
       ) VALUES (
         @profileId, @theme, @autoSync, @syncIntervalMinutes,
         @chatModel, @chatApiUrl, @embedModel, @embedApiUrl,
         @apiKeyValue, @apiKeyEncrypted, @updatedAt
       )
       ON CONFLICT(profile_id) DO UPDATE SET
         theme = excluded.theme,
         auto_sync = excluded.auto_sync,
         sync_interval_minutes = excluded.sync_interval_minutes,
         chat_model = excluded.chat_model,
         chat_api_url = excluded.chat_api_url,
         embed_model = excluded.embed_model,
         embed_api_url = excluded.embed_api_url,
         api_key_value = excluded.api_key_value,
         api_key_encrypted = excluded.api_key_encrypted,
         updated_at = excluded.updated_at`,
    )
    .run({
      profileId,
      theme: stored.general.theme,
      autoSync: stored.general.autoSync ? 1 : 0,
      syncIntervalMinutes: stored.general.syncIntervalMinutes,
      chatModel: stored.ai.chatModel,
      chatApiUrl: stored.ai.chatApiUrl,
      embedModel: stored.ai.embedModel,
      embedApiUrl: stored.ai.embedApiUrl,
      apiKeyValue: stored.apiKey ? stored.apiKey.value : null,
      apiKeyEncrypted: stored.apiKey?.encrypted ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });
}

// A profile without a settings row simply uses defaults; the row is created on
// the first save. Reading never writes.
function loadProfileStored(profileId) {
  const row = getDb()
    .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
    .get(profileId);

  return rowToStored(row);
}

// Copies version 1 global settings into the profiles that existed before the
// upgrade, then rewrites the settings file without them. Every pre-existing
// profile behaved with the same global theme, sync policy and model choices, so
// they all receive those non-secret values and look unchanged after upgrading.
// The API key is the exception: it goes to the default profile only, so the
// upgrade never copies a secret into profiles that never held it. A profile
// that used the old global key can enter its own in Settings, or keep using
// NVIDIA_NIM_API_KEY from the environment.
//
// The database write comes first and is one transaction: a crash between it and
// the file rewrite leaves the rows in place, and the next launch sees them,
// skips the copy, and finishes the rewrite. An existing row is never
// overwritten, so a profile's saved settings always win over a stale file.
function migrateLegacySettings() {
  if (!legacy) return;

  const db = getDb();
  const defaultId = getDefaultProfileId();

  if (defaultId === null) {
    throw new Error("The default profile is missing.");
  }

  const profileIds = db
    .prepare("SELECT id FROM workspaces ORDER BY id")
    .all()
    .map((row) => row.id);
  const hasRow = db.prepare("SELECT 1 FROM profile_settings WHERE profile_id = ?");

  db.transaction(() => {
    for (const profileId of profileIds) {
      if (hasRow.get(profileId)) continue;

      writeProfileRow(profileId, {
        ...clone(legacy),
        apiKey: profileId === defaultId ? legacy.apiKey : null,
      });
    }
  })();

  legacy = null;
  writeInstallFile(install);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function getActiveProfileId() {
  return resolveProfileId(install.activeProfileId);
}

function resolveAiField(stored, field) {
  if (stored.ai[field]) return stored.ai[field];

  const envValue = (process.env[ENV_NAMES[field]] || "").trim();

  return envValue || DEFAULTS.ai[field];
}

// The full configuration the main process acts on, including the secret, for
// the active profile. This must never cross the IPC boundary.
function getResolvedSettings() {
  const profileId = getActiveProfileId();
  const stored = loadProfileStored(profileId);
  const storedApiKey = decryptApiKey(stored.apiKey);
  const environmentApiKey = (process.env[ENV_NAMES.apiKey] || "").trim();
  const apiKey = storedApiKey || environmentApiKey || null;

  return {
    profileId,
    stored,
    ai: {
      apiKey,
      apiKeySource: storedApiKey
        ? "settings"
        : environmentApiKey
          ? "environment"
          : "none",
      chatModel: resolveAiField(stored, "chatModel"),
      chatApiUrl: resolveAiField(stored, "chatApiUrl"),
      embedModel: resolveAiField(stored, "embedModel"),
      embedApiUrl: resolveAiField(stored, "embedApiUrl"),
    },
    general: { ...stored.general, activeProfileId: profileId },
  };
}

// Safe for the renderer: reports whether a key exists and where it came from,
// but never the key itself.
function getPublicSettings() {
  const resolved = getResolvedSettings();
  const profile = findProfile(resolved.profileId);

  return {
    profile: profile
      ? { id: profile.id, name: profile.name, isDefault: profile.isDefault }
      : null,
    ai: {
      apiKeySource: resolved.ai.apiKeySource,
      hasApiKey: Boolean(resolved.ai.apiKey),
      // Stored overrides, so the form shows which values are pinned in
      // Settings. An empty string means "use the effective value below",
      // which is the environment override or the built-in default.
      chatModel: resolved.stored.ai.chatModel,
      chatApiUrl: resolved.stored.ai.chatApiUrl,
      embedModel: resolved.stored.ai.embedModel,
      embedApiUrl: resolved.stored.ai.embedApiUrl,
      effective: {
        chatModel: resolved.ai.chatModel,
        chatApiUrl: resolved.ai.chatApiUrl,
        embedModel: resolved.ai.embedModel,
        embedApiUrl: resolved.ai.embedApiUrl,
      },
    },
    general: resolved.general,
    defaults: clone(DEFAULTS),
  };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function validateAiPatch(next, patch) {
  for (const field of AI_FIELDS) {
    if (!(field in patch)) continue;

    const value = patch[field];

    if (typeof value !== "string") {
      throw new Error(`Invalid value for ${field}.`);
    }

    const trimmed = value.trim();

    if (!trimmed) {
      // Clearing an override falls back to the environment or default.
      next.ai[field] = "";
      continue;
    }

    const limit = field.endsWith("ApiUrl") ? MAX_URL_LENGTH : MAX_MODEL_LENGTH;

    if (trimmed.length > limit) {
      throw new Error(`${field} is too long.`);
    }

    if (field.endsWith("ApiUrl") && !isHttpUrl(trimmed)) {
      throw new Error(`${field} must be an http or https URL.`);
    }

    next.ai[field] = trimmed;
  }

  if ("apiKey" in patch) {
    const value = patch.apiKey;

    if (value === null || value === "") {
      next.apiKey = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();

      if (trimmed.length > MAX_API_KEY_LENGTH) {
        throw new Error("API key is too long.");
      }

      next.apiKey = trimmed ? encryptApiKey(trimmed) : null;
    } else {
      throw new Error("Invalid API key.");
    }
  }
}

function validateGeneralPatch(next, patch) {
  if ("theme" in patch) {
    if (!THEMES.has(patch.theme)) {
      throw new Error("Theme must be light, dark, or system.");
    }

    next.general.theme = patch.theme;
  }

  if ("autoSync" in patch) {
    if (typeof patch.autoSync !== "boolean") {
      throw new Error("Auto-sync must be true or false.");
    }

    next.general.autoSync = patch.autoSync;
  }

  if ("syncIntervalMinutes" in patch) {
    if (!isValidSyncInterval(patch.syncIntervalMinutes)) {
      throw new Error(
        `Sync interval must be a whole number of minutes between ${MIN_SYNC_INTERVAL_MINUTES} and ${MAX_SYNC_INTERVAL_MINUTES}.`,
      );
    }

    next.general.syncIntervalMinutes = patch.syncIntervalMinutes;
  }

  if ("activeProfileId" in patch) {
    // Switching is a separate operation because it changes which repositories
    // are visible, not just a value inside the current profile.
    throw new Error("Use the profile switcher to change the active profile.");
  }
}

// Applies a partial update to the ACTIVE profile. Fields that are absent are
// left untouched; an empty string clears an AI override (falling back to
// env/default), and `apiKey: null` clears the profile's stored key.
function updateSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid settings update.");
  }

  const profileId = getActiveProfileId();
  const current = loadProfileStored(profileId);
  const next = {
    ai: { ...current.ai },
    general: { ...current.general },
    apiKey: current.apiKey,
  };

  if (patch.general !== undefined) {
    if (!patch.general || typeof patch.general !== "object") {
      throw new Error("Invalid general settings.");
    }

    validateGeneralPatch(next, patch.general);
  }

  if (patch.ai !== undefined) {
    if (!patch.ai || typeof patch.ai !== "object") {
      throw new Error("Invalid AI settings.");
    }

    validateAiPatch(next, patch.ai);
  }

  writeProfileRow(profileId, next);

  return getPublicSettings();
}

// Makes `profileId` the active profile and remembers it for the next launch.
// Null clears the explicit choice, which resolves to the default profile. The
// file is written before the in-memory selection changes, so a failed write
// leaves the running app and the disk in agreement.
function setActiveProfile(profileId) {
  if (profileId !== null && !isValidProfileId(profileId)) {
    throw new Error("Invalid profile.");
  }

  if (profileId !== null && !findProfile(profileId)) {
    throw new Error("Profile not found.");
  }

  const next = { ...install, activeProfileId: profileId };

  writeInstallFile(next);
  install = next;

  return getPublicSettings();
}

// Loads the install-wide file at `resolvedPath` and migrates any version 1
// values into the default profile. The database must already be initialized.
// Passing null resets to defaults, which the tests use to isolate cases.
function initializeSettings(resolvedPath) {
  settingsFilePath = resolvedPath ?? null;

  const loaded = readInstallFile();

  install = loaded.install;
  legacy = loaded.legacy;

  if (legacy) {
    try {
      migrateLegacySettings();
    } catch (error) {
      // Keep going on defaults and retry on the next launch: a failed
      // migration must not stop the app from opening.
      console.error("Settings migration failed:", error);
    }
  }

  return settingsFilePath ? getPublicSettings() : null;
}

module.exports = {
  DEFAULTS,
  ENV_NAMES,
  initializeSettings,
  getPublicSettings,
  getResolvedSettings,
  getActiveProfileId,
  setActiveProfile,
  updateSettings,
  // Exposed for the settings page's validation hints.
  MIN_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
};
