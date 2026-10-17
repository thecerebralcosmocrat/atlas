import { useEffect, useState } from "react";
import {
  FolderOpen,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const MIN_SYNC_MINUTES = 1;
const MAX_SYNC_MINUTES = 120;

const AI_FIELDS = [
  {
    name: "chatModel",
    label: "Chat model",
    hint: "Answers questions about a repository.",
  },
  {
    name: "chatApiUrl",
    label: "Chat endpoint",
    hint: "OpenAI-compatible chat completions URL.",
  },
  {
    name: "embedModel",
    label: "Embedding model",
    hint: "Turns indexed code into vectors for semantic retrieval.",
  },
  {
    name: "embedApiUrl",
    label: "Embedding endpoint",
    hint: "OpenAI-compatible embeddings URL.",
  },
];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${
    units[exponent]
  }`;
}

function Section({ title, description, action, children }) {
  return (
    <section className="border border-border">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, htmlFor, hint, children }) {
  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-start">
      <div className="min-w-0">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="block text-sm font-medium text-foreground"
          >
            {label}
          </label>
        ) : (
          <span className="block text-sm font-medium text-foreground">
            {label}
          </span>
        )}
        {hint && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Description({ children, tone = "muted" }) {
  return (
    <p
      className={cn(
        "text-xs leading-relaxed",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

export default function Settings({ settings, onUpdateSettings }) {
  const settingsApi = window.electronAPI?.settings;
  const [aiForm, setAiForm] = useState({
    chatModel: "",
    chatApiUrl: "",
    embedModel: "",
    embedApiUrl: "",
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [aiStatus, setAiStatus] = useState(null);
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState(null);
  const [generalStatus, setGeneralStatus] = useState(null);
  const [intervalDraft, setIntervalDraft] = useState("");
  const [storage, setStorage] = useState(null);
  const [storageError, setStorageError] = useState("");
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);

  useEffect(() => {
    if (!settings) return;

    setAiForm({
      chatModel: settings.ai.chatModel,
      chatApiUrl: settings.ai.chatApiUrl,
      embedModel: settings.ai.embedModel,
      embedApiUrl: settings.ai.embedApiUrl,
    });
    setIntervalDraft(String(settings.general.syncIntervalMinutes));
  }, [settings]);

  const loadStorage = async () => {
    if (!settingsApi) return;

    setIsLoadingStorage(true);
    setStorageError("");

    try {
      setStorage(await settingsApi.storageInfo());
    } catch (error) {
      setStorageError(error.message || "Could not read storage usage.");
    } finally {
      setIsLoadingStorage(false);
    }
  };

  useEffect(() => {
    loadStorage();
    // Storage usage is read once on mount and on demand; it does not depend on
    // any renderer state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settingsApi) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Settings are only available in the Atlas desktop app.
        </p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      </div>
    );
  }

  const updateGeneral = async (patch, message) => {
    setGeneralStatus(null);

    try {
      await onUpdateSettings({ general: patch });
      setGeneralStatus({ ok: true, message });
      return true;
    } catch (error) {
      setGeneralStatus({
        ok: false,
        message: error.message || "Could not save settings.",
      });
      return false;
    }
  };

  const commitSyncInterval = async () => {
    const value = Number(intervalDraft);
    const current = settings.general.syncIntervalMinutes;

    if (
      !Number.isInteger(value) ||
      value < MIN_SYNC_MINUTES ||
      value > MAX_SYNC_MINUTES
    ) {
      setGeneralStatus({
        ok: false,
        message: `Use a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`,
      });
      setIntervalDraft(String(current));
      return;
    }

    if (value === current) return;

    const saved = await updateGeneral(
      { syncIntervalMinutes: value },
      "Sync schedule updated.",
    );

    if (!saved) setIntervalDraft(String(current));
  };

  // The draft key is only sent when the user typed one; an empty input means
  // "leave the stored key alone", which is why there is a separate Remove
  // action for clearing it.
  const saveAiDraft = async () => {
    const ai = { ...aiForm };

    if (apiKeyDraft.trim()) {
      ai.apiKey = apiKeyDraft.trim();
    }

    await onUpdateSettings({ ai });
    setApiKeyDraft("");
  };

  const handleSaveAi = async () => {
    setIsSavingAi(true);
    setAiStatus(null);

    try {
      await saveAiDraft();
      setAiStatus({ ok: true, message: "AI settings saved." });
    } catch (error) {
      setAiStatus({
        ok: false,
        message: error.message || "Could not save AI settings.",
      });
    } finally {
      setIsSavingAi(false);
    }
  };

  // Testing the saved configuration is the point: it is what the app will
  // actually use. Saving first means the test covers the values on screen.
  const handleTestConnection = async () => {
    setIsTesting(true);
    setAiStatus(null);
    setConnectionResult(null);

    try {
      await saveAiDraft();
      setConnectionResult(await settingsApi.testConnection());
    } catch (error) {
      setAiStatus({
        ok: false,
        message: error.message || "Could not test the connection.",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleRemoveKey = async () => {
    setIsSavingAi(true);
    setAiStatus(null);

    try {
      await onUpdateSettings({ ai: { apiKey: null } });
      setApiKeyDraft("");
      setAiStatus({ ok: true, message: "API key removed." });
    } catch (error) {
      setAiStatus({
        ok: false,
        message: error.message || "Could not remove the API key.",
      });
    } finally {
      setIsSavingAi(false);
    }
  };

  const handleOpenStorage = async () => {
    setStorageError("");

    try {
      await settingsApi.openStorageFolder();
    } catch (error) {
      setStorageError(error.message || "Could not open the data folder.");
    }
  };

  const keyDescription =
    settings.ai.apiKeySource === "settings"
      ? "Stored encrypted on this device."
      : settings.ai.apiKeySource === "environment"
        ? "Using NVIDIA_NIM_API_KEY from the environment. A key saved here overrides it."
        : "No key configured. Answers fall back to the local keyword index; semantic retrieval and generated answers stay off.";

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
      <header className="px-4 pb-4 pt-4">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Application
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.055em] text-foreground">
          Settings
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Global preferences for this device. These apply to every repository.
        </p>
      </header>

      <div className="grid max-w-[860px] gap-4 px-4 pb-8">
        <Section
          title="Appearance"
          description="The app follows your choice immediately, including the window controls."
        >
          <Row label="Theme" hint="System matches your operating system.">
            <div role="group" aria-label="Theme" className="flex flex-wrap gap-2">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = settings.general.theme === value;

                return (
                  <Button
                    key={value}
                    type="button"
                    variant={active ? "default" : "outline"}
                    size="sm"
                    aria-pressed={active}
                    onClick={() => updateGeneral({ theme: value }, "Theme updated.")}
                  >
                    <Icon />
                    {label}
                  </Button>
                );
              })}
            </div>
          </Row>
        </Section>

        <Section
          title="Sync"
          description="Atlas checks cloned repositories for new commits. Only a repository that actually moved is fetched and re-indexed."
        >
          <Row
            label="Automatic sync"
            hint="Runs in the background while the app is open."
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={settings.general.autoSync}
                aria-label="Automatic sync"
                onClick={() =>
                  updateGeneral(
                    { autoSync: !settings.general.autoSync },
                    settings.general.autoSync
                      ? "Automatic sync turned off."
                      : "Automatic sync turned on.",
                  )
                }
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center border border-border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  settings.general.autoSync ? "bg-primary" : "bg-secondary",
                )}
              >
                <span
                  className={cn(
                    "block size-4 border border-border bg-background shadow-sm transition-transform duration-150 ease-out",
                    settings.general.autoSync
                      ? "translate-x-[22px]"
                      : "translate-x-[3px]",
                  )}
                />
              </button>
              <span className="text-sm text-muted-foreground">
                {settings.general.autoSync
                  ? "Checking remotes in the background."
                  : "Background checks are off."}
              </span>
            </div>
          </Row>

          <Row
            label="Check interval"
            htmlFor="sync-interval"
            hint={`Every ${settings.general.syncIntervalMinutes} minutes while enabled.`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="sync-interval"
                type="number"
                min={MIN_SYNC_MINUTES}
                max={MAX_SYNC_MINUTES}
                step={1}
                value={intervalDraft}
                disabled={!settings.general.autoSync}
                onChange={(event) => setIntervalDraft(event.target.value)}
                onBlur={commitSyncInterval}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </Row>

          {generalStatus && (
            <div
              role="status"
              className="px-4 py-2 text-xs"
              aria-live="polite"
            >
              <Description tone={generalStatus.ok ? "muted" : "error"}>
                {generalStatus.message}
              </Description>
            </div>
          )}
        </Section>

        <Section
          title="AI provider"
          description="NVIDIA NIM powers generated answers and semantic retrieval. Without a key, Atlas still answers from the local keyword index."
        >
          <Row
            label="API key"
            htmlFor="ai-api-key"
            hint={keyDescription}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="ai-api-key"
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder={
                  settings.ai.hasApiKey
                    ? "Enter a new key to replace the current one"
                    : "Paste your NVIDIA NIM API key"
                }
                autoComplete="off"
                spellCheck={false}
                className="min-w-48 flex-1"
              />
              {settings.ai.apiKeySource === "settings" && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleRemoveKey}
                  disabled={isSavingAi || isTesting}
                >
                  <Trash2 />
                  Remove
                </Button>
              )}
            </div>
          </Row>

          {AI_FIELDS.map((field) => (
            <Row
              key={field.name}
              label={field.label}
              htmlFor={`ai-${field.name}`}
              hint={`${field.hint} Leave blank to use ${
                settings.ai.effective[field.name]
              }.`}
            >
              <Input
                id={`ai-${field.name}`}
                value={aiForm[field.name]}
                onChange={(event) =>
                  setAiForm((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                placeholder={settings.ai.effective[field.name]}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Row>
          ))}

          <div className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={handleSaveAi}
                disabled={isSavingAi || isTesting}
              >
                {isSavingAi ? "Saving…" : "Save changes"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleTestConnection}
                disabled={isSavingAi || isTesting}
              >
                <RefreshCw
                  className={cn("size-3.5", isTesting && "animate-spin")}
                />
                {isTesting ? "Testing…" : "Save & test connection"}
              </Button>
            </div>

            <div className="mt-3 min-h-4" aria-live="polite">
              {aiStatus && (
                <Description tone={aiStatus.ok ? "muted" : "error"}>
                  {aiStatus.message}
                </Description>
              )}

              {connectionResult && (
                <div className="mt-2 space-y-1 border border-border p-3">
                  {connectionResult.error ? (
                    <Description tone="error">
                      {connectionResult.error}
                    </Description>
                  ) : (
                    <>
                      <Description
                        tone={connectionResult.chat?.ok ? "muted" : "error"}
                      >
                        Chat:{" "}
                        {connectionResult.chat?.ok
                          ? connectionResult.chat.message
                          : connectionResult.chat?.error}
                      </Description>
                      <Description
                        tone={
                          connectionResult.embeddings?.ok ? "muted" : "error"
                        }
                      >
                        Embeddings:{" "}
                        {connectionResult.embeddings?.ok
                          ? connectionResult.embeddings.message
                          : connectionResult.embeddings?.error}
                      </Description>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="Storage"
          description="Where Atlas keeps its database and cloned repositories."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadStorage}
              disabled={isLoadingStorage}
            >
              <RefreshCw
                className={cn("size-3.5", isLoadingStorage && "animate-spin")}
              />
              {isLoadingStorage ? "Reading…" : "Refresh"}
            </Button>
          }
        >
          {storageError && (
            <div className="px-4 py-3">
              <Description tone="error">{storageError}</Description>
            </div>
          )}

          <Row label="Data folder">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
                {storage?.dataPath ?? "Loading…"}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenStorage}
                disabled={!storage}
              >
                <FolderOpen />
                Open folder
              </Button>
            </div>
          </Row>

          <Row label="Database">
            <p className="text-sm tabular-nums text-foreground">
              {storage ? formatBytes(storage.databaseBytes) : "…"}
            </p>
          </Row>

          <Row label="Cloned repositories">
            <p className="text-sm tabular-nums text-foreground">
              {storage
                ? `${formatBytes(storage.repositoriesBytes)} · ${
                    storage.repositoryCount
                  } ${
                    storage.repositoryCount === 1
                      ? "repository"
                      : "repositories"
                  }`
                : "…"}
            </p>
          </Row>
        </Section>
      </div>
    </div>
  );
}
