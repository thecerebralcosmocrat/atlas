const fs = require("node:fs");
const path = require("node:path");

// Global application settings. Deliberately not per repository: one provider
// configuration and one sync policy cover the whole app, and workspaces
// (Personal/Work) will scope repositories, not credentials.
//
// Stored as a small JSON file in the app's data folder rather than the SQLite
// index: settings must be readable before the database exists, and they are not
// part of the repository index. `electron-store` is ESM-only and the main
// process is CommonJS, so a tiny atomic writer does the job instead.

const SETTINGS_VERSION = 1;

const THEMES = new Set(["light", "dark", "system"]);
const MIN_SYNC_INTERVAL_MINUTES = 1;
const MAX_SYNC_INTERVAL_MINUTES = 120;
const MAX_MODEL_LENGTH = 200;
const MAX_URL_LENGTH = 500;
const MAX_API_KEY_LENGTH = 500;
const AI_FIELDS = ["chatModel", "chatApiUrl", "embedModel", "embedApiUrl"];

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
    // The workspace whose repositories the sidebar shows. Stored here rather
    // than in the database so the last selection survives restarts even if the
    // index is rebuilt. Null means "resolve to the default workspace".
    activeWorkspaceId: null,
  },
});

// Environment variables remain a fallback so existing `.env` workflows keep
// working. A value saved in the UI wins, which is what makes the settings page
// effective without requiring a restart or a rebuild of the environment.
const ENV_NAMES = {
  apiKey: "NVIDIA_NIM_API_KEY",
  chatModel: "NVIDIA_NIM_MODEL",
  chatApiUrl: "NVIDIA_NIM_API_URL",
  embedModel: "NVIDIA_NIM_EMBED_MODEL",
  embedApiUrl: "NVIDIA_NIM_EMBED_API_URL",
};

let settingsFilePath = null;
let stored = createEmptyStoredSettings();

function createEmptyStoredSettings() {
  return {
    ai: {
      chatModel: "",
      chatApiUrl: "",
      embedModel: "",
      embedApiUrl: "",
    },
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
    // A settings file copied from another machine cannot be decrypted here.
    // Treat it as unset rather than crashing the app on every launch.
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

function isValidWorkspaceId(value) {
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

// A corrupt or partially written settings file must never stop the app from
// starting. Unknown and malformed values fall back to their defaults.
function normalizeStoredSettings(value) {
  const next = createEmptyStoredSettings();

  if (!value || typeof value !== "object") return next;

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
  if (isValidWorkspaceId(general.activeWorkspaceId)) {
    next.general.activeWorkspaceId = general.activeWorkspaceId;
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

function readStoredSettings() {
  if (!settingsFilePath) return createEmptyStoredSettings();

  let contents;

  try {
    contents = fs.readFileSync(settingsFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyStoredSettings();
    throw error;
  }

  try {
    return normalizeStoredSettings(JSON.parse(contents));
  } catch (error) {
    console.warn("Ignoring unreadable settings file:", error.message);
    return createEmptyStoredSettings();
  }
}

function writeStoredSettings(next) {
  if (!settingsFilePath) {
    throw new Error("Settings storage has not been initialized.");
  }

  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });

  const payload = {
    version: SETTINGS_VERSION,
    ai: next.ai,
    general: next.general,
    apiKey: next.apiKey,
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

function resolveAiField(field) {
  if (stored.ai[field]) return stored.ai[field];

  const envValue = (process.env[ENV_NAMES[field]] || "").trim();

  return envValue || DEFAULTS.ai[field];
}

// The full configuration the main process acts on, including the secret. This
// must never cross the IPC boundary.
function getResolvedSettings() {
  const storedApiKey = decryptApiKey(stored.apiKey);
  const environmentApiKey = (process.env[ENV_NAMES.apiKey] || "").trim();
  const apiKey = storedApiKey || environmentApiKey || null;

  return {
    ai: {
      apiKey,
      apiKeySource: storedApiKey
        ? "settings"
        : environmentApiKey
          ? "environment"
          : "none",
      chatModel: resolveAiField("chatModel"),
      chatApiUrl: resolveAiField("chatApiUrl"),
      embedModel: resolveAiField("embedModel"),
      embedApiUrl: resolveAiField("embedApiUrl"),
    },
    general: { ...stored.general },
  };
}

// Safe for the renderer: reports whether a key exists and where it came from,
// but never the key itself.
function getPublicSettings() {
  const resolved = getResolvedSettings();

  return {
    ai: {
      apiKeySource: resolved.ai.apiKeySource,
      hasApiKey: Boolean(resolved.ai.apiKey),
      // Stored overrides, so the form shows which values are pinned in
      // Settings. An empty string means "use the effective value below",
      // which is the environment override or the built-in default.
      chatModel: stored.ai.chatModel,
      chatApiUrl: stored.ai.chatApiUrl,
      embedModel: stored.ai.embedModel,
      embedApiUrl: stored.ai.embedApiUrl,
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

  if ("activeWorkspaceId" in patch) {
    const value = patch.activeWorkspaceId;

    if (value !== null && !isValidWorkspaceId(value)) {
      throw new Error("Invalid active workspace.");
    }

    next.general.activeWorkspaceId = value;
  }
}

// Applies a partial update. Fields that are absent are left untouched; an empty
// string clears an AI override (falling back to env/default), and `apiKey: null`
// clears the stored key.
function updateSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid settings update.");
  }

  const next = {
    ai: { ...stored.ai },
    general: { ...stored.general },
    apiKey: stored.apiKey,
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

  // Persist before adopting the new state: a failed write must not leave the
  // running app configured differently from what is on disk.
  writeStoredSettings(next);
  stored = next;

  return getPublicSettings();
}

// Loads the file at `resolvedPath`. Passing null resets to defaults, which the
// tests use to isolate cases.
function initializeSettings(resolvedPath) {
  settingsFilePath = resolvedPath ?? null;
  stored = readStoredSettings();

  return getPublicSettings();
}

module.exports = {
  DEFAULTS,
  ENV_NAMES,
  initializeSettings,
  getPublicSettings,
  getResolvedSettings,
  updateSettings,
  // Exposed for the settings page's validation hints.
  MIN_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
};
