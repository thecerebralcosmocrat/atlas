import { useEffect, useRef, useState } from "react";
import { Icon, Add, Edit, External, TrashCan } from "@/components/glaze/icon";
import { Button } from "@/components/glaze/ui/button";
import {
  DataList,
  DataListItem,
  DataListLabel,
  DataListValue,
} from "@/components/glaze/ui/data-list";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/glaze/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FormStatus,
} from "@/components/glaze/ui/field";
import { Input } from "@/components/glaze/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/glaze/ui/item";
import { NumberInput } from "@/components/glaze/ui/number-input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/glaze/ui/segmented-control";
import { Status } from "@/components/glaze/ui/status";
import { Switch } from "@/components/glaze/ui/switch";
import { Alert, AlertTitle } from "@/components/glaze/ui/alert";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
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
    <section className="flex flex-col gap-4 border-t border-line-faint py-6 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="type-heading-sm text-text-1">{title}</h2>
          <p className="type-body-sm max-w-measure text-text-2">{description}</p>
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

function profileCountLabel(count) {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

// Profiles scope the sidebar. They are managed here rather than in the
// switcher so creating one is a deliberate action and a rename has room for a
// description. Profiles are isolated from each other, so deleting one deletes
// its repositories and their indexes, which is why the confirmation says so.
function ProfileSection({
  profiles = [],
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
}) {
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  // The profile stays set while the dialog fades out so its name does not
  // vanish mid-exit; only confirmOpen drives visibility.
  const [confirmProfile, setConfirmProfile] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const startEditing = (profile) => {
    setEditingId(profile.id);
    setDraftName(profile.name);
    setDraftDescription(profile.description);
    setStatus(null);
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    setStatus(null);

    try {
      await onCreateProfile({ name: newName, description: newDescription });
      setNewName("");
      setNewDescription("");
      setStatus({ ok: true, message: "Profile created." });
    } catch (error) {
      setStatus({
        ok: false,
        message: error.message || "Could not create the profile.",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSave = async (profileId) => {
    setIsBusy(true);
    setStatus(null);

    try {
      await onUpdateProfile(profileId, {
        name: draftName,
        description: draftDescription,
      });
      setEditingId(null);
      setStatus({ ok: true, message: "Profile updated." });
    } catch (error) {
      setStatus({
        ok: false,
        message: error.message || "Could not update the profile.",
      });
    } finally {
      setIsBusy(false);
    }
  };

  // The dialog stays open and pending until this settles, and shows the
  // message of a rejection, so a failure stays visible.
  const handleDelete = async () => {
    if (!confirmProfile) return;

    setIsBusy(true);
    setStatus(null);

    try {
      const result = await onDeleteProfile(confirmProfile.id);
      const removed = result?.removedRepositoryCount ?? 0;

      setStatus({
        ok: true,
        message:
          removed > 0
            ? `Profile deleted. ${profileCountLabel(removed)} deleted with it.`
            : "Profile deleted.",
      });
    } catch (error) {
      const message = error.message || "Could not delete the profile.";

      setStatus({ ok: false, message });
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <>
      <ItemGroup variant="plain" aria-label="Profiles" className="-mx-3 w-auto">
        {profiles.map((profile) =>
          editingId === profile.id ? (
            <Item key={profile.id} className="py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    aria-label={`Name for ${profile.name}`}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    disabled={isBusy}
                  />
                </Field>
                <Field>
                  <FieldLabel optional>Description</FieldLabel>
                  <Input
                    aria-label={`Description for ${profile.name}`}
                    value={draftDescription}
                    onChange={(event) =>
                      setDraftDescription(event.target.value)
                    }
                    disabled={isBusy}
                  />
                </Field>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setEditingId(null)}
                    disabled={isBusy}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    pending={isBusy}
                    pendingLabel="Saving"
                    onClick={() => handleSave(profile.id)}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </Item>
          ) : (
            <Item key={profile.id}>
              <ItemContent>
                <ItemTitle>{profile.name}</ItemTitle>
                <ItemDescription>
                  {`${profileCountLabel(profile.repositoryCount)}${
                    profile.description ? ` · ${profile.description}` : ""
                  }${profile.isDefault ? " · Default profile" : ""}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => startEditing(profile)}
                >
                  <Icon icon={Edit} />
                  Rename
                </Button>
                {!profile.isDefault && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setStatus(null);
                      setConfirmProfile(profile);
                      setConfirmOpen(true);
                    }}
                  >
                    <Icon icon={TrashCan} />
                    Delete
                  </Button>
                )}
              </ItemActions>
            </Item>
          ),
        )}
      </ItemGroup>

      <form className="flex flex-col gap-3" onSubmit={handleCreate}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Field>
            <FieldLabel>New profile name</FieldLabel>
            <Input
              placeholder="Work"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={isBusy}
              autoComplete="off"
            />
          </Field>
          <Field>
            <FieldLabel optional>Description</FieldLabel>
            <Input
              aria-label="New profile description"
              placeholder="Client repositories"
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              disabled={isBusy}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <FormStatus status={status ? (status.ok ? "ok" : "fail") : undefined}>
            {status?.message}
          </FormStatus>
          <Button
            type="submit"
            size="sm"
            disabled={isBusy || !newName.trim()}
          >
            <Icon icon={Add} />
            Create
          </Button>
        </div>
      </form>

      <Dialog
        role="alertdialog"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {confirmProfile?.name}?</DialogTitle>
            <DialogDescription>
              {confirmProfile
                ? `${profileCountLabel(
                    confirmProfile.repositoryCount,
                  )} in this profile will be permanently deleted, along with everything indexed from them. Repositories cloned into Atlas are deleted from disk. This profile's theme, sync, and AI settings, including its API key, are deleted too. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <DialogAction
              variant="destructive"
              onAction={handleDelete}
              pendingLabel="Deleting"
            >
              Delete profile
            </DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Settings({
  settings,
  profiles = [],
  onUpdateSettings,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
}) {
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
  const [intervalDraft, setIntervalDraft] = useState(null);
  const [storage, setStorage] = useState(null);
  const [storageError, setStorageError] = useState("");
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);
  const [isSavingSync, setIsSavingSync] = useState(false);
  // Base UI clamps a typed number to min/max before it commits, which would hide
  // the out-of-range message, so the last typed value is kept here.
  const typedIntervalRef = useRef(null);

  useEffect(() => {
    if (!settings) return;

    setAiForm({
      chatModel: settings.ai.chatModel,
      chatApiUrl: settings.ai.chatApiUrl,
      embedModel: settings.ai.embedModel,
      embedApiUrl: settings.ai.embedApiUrl,
    });
    setIntervalDraft(settings.general.syncIntervalMinutes);
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
        <p className="max-w-md text-center type-body text-text-2">
          Settings are only available in the Atlas desktop app.
        </p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="type-body text-text-2">Loading settings…</p>
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

  const commitSyncInterval = async (committed) => {
    const typed = typedIntervalRef.current;
    const value = typed === null ? committed : typed;
    const current = settings.general.syncIntervalMinutes;

    typedIntervalRef.current = null;

    if (
      value === null ||
      value === undefined ||
      !Number.isInteger(value) ||
      value < MIN_SYNC_MINUTES ||
      value > MAX_SYNC_MINUTES
    ) {
      setGeneralStatus({
        ok: false,
        message: `Use a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`,
      });
      setIntervalDraft(current);
      return;
    }

    if (value === current) {
      setIntervalDraft(current);
      return;
    }

    const saved = await updateGeneral(
      { syncIntervalMinutes: value },
      "Sync schedule updated.",
    );

    if (!saved) setIntervalDraft(current);
  };

  const toggleAutoSync = async (next) => {
    setIsSavingSync(true);

    try {
      await updateGeneral(
        { autoSync: next },
        next ? "Automatic sync turned on." : "Automatic sync turned off.",
      );
    } finally {
      setIsSavingSync(false);
    }
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
      <div className="flex max-w-3xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="type-title text-text-1">Settings</h1>
          <p className="type-body max-w-measure text-text-2">
            {`Appearance, sync and AI settings belong to the ${settings.profile?.name ?? "active"} profile. Switch profiles from the sidebar to use different settings and API keys.`}
          </p>
        </header>

        <div className="flex flex-col">
          <Section
            title="Appearance"
            description="Saved for the active profile. The app follows your choice immediately, including the window controls."
          >
            <FieldSet>
              <FieldLegend variant="label">Theme</FieldLegend>
              <SegmentedControl
                aria-label="Theme"
                value={settings.general.theme}
                onValueChange={(value) =>
                  updateGeneral({ theme: value }, "Theme updated.")
                }
              >
                {THEME_OPTIONS.map(({ value, label }) => (
                  <SegmentedControlItem key={value} value={value}>
                    {label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <FieldDescription>
                System matches your operating system.
              </FieldDescription>
            </FieldSet>
          </Section>

          <Section
            title="Sync"
            description="Atlas checks this profile's cloned repositories for new commits. Only a repository that actually moved is fetched and re-indexed."
          >
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Automatic sync</FieldLabel>
                <FieldDescription>
                  Runs in the background while the app is open.
                </FieldDescription>
                <FieldDescription>
                  {settings.general.autoSync
                    ? "Checking remotes in the background."
                    : "Background checks are off."}
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={settings.general.autoSync}
                pending={isSavingSync}
                onCheckedChange={toggleAutoSync}
              />
            </Field>

            <Field disabled={!settings.general.autoSync}>
              <FieldLabel>Check interval</FieldLabel>
              <NumberInput
                className="w-48"
                unit="minutes"
                min={MIN_SYNC_MINUTES}
                max={MAX_SYNC_MINUTES}
                step={1}
                value={intervalDraft}
                disabled={!settings.general.autoSync}
                onValueChange={(value) => {
                  typedIntervalRef.current = value;
                  setIntervalDraft(value);
                }}
                onValueCommitted={commitSyncInterval}
              />
              <FieldDescription>
                {`Every ${settings.general.syncIntervalMinutes} minutes while enabled.`}
              </FieldDescription>
            </Field>

            <FormStatus
              className="empty:-mb-5 empty:min-h-0"
              status={generalStatus ? (generalStatus.ok ? "ok" : "fail") : undefined}
            >
              {generalStatus?.message}
            </FormStatus>
          </Section>

          <Section
            title="Profiles"
            description="Each profile has its own repositories, theme, sync policy, and AI provider settings including its API key. Deleting a profile moves its repositories to the default profile and removes its settings and key."
          >
            <ProfileSection
              profiles={profiles}
              onCreateProfile={onCreateProfile}
              onUpdateProfile={onUpdateProfile}
              onDeleteProfile={onDeleteProfile}
            />
          </Section>

          <Section
            title="AI provider"
            description="NVIDIA NIM powers generated answers and semantic retrieval. These values and the API key belong to the active profile only. Without a key, Atlas still answers from the local keyword index."
          >
            <Field>
              <FieldLabel>API key</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  mode="password"
                  mono
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
                    <Icon icon={TrashCan} />
                    Remove
                  </Button>
                )}
              </div>
              <FieldDescription>{keyDescription}</FieldDescription>
            </Field>

            {AI_FIELDS.map((field) => (
              <Field key={field.name}>
                <FieldLabel>{field.label}</FieldLabel>
                <Input
                  mono
                  value={aiForm[field.name]}
                  onChange={(event) =>
                    setAiForm((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  placeholder={settings.ai.effective[field.name]}
                  spellCheck={false}
                  autoComplete="off"
                />
                <FieldDescription>
                  {`${field.hint} Leave blank to use ${
                    settings.ai.effective[field.name]
                  }.`}
                </FieldDescription>
              </Field>
            ))}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleTestConnection}
                pending={isTesting}
                pendingLabel="Testing"
                disabled={isSavingAi}
              >
                Save and test connection
              </Button>
              <Button
                type="button"
                onClick={handleSaveAi}
                pending={isSavingAi}
                pendingLabel="Saving"
                disabled={isTesting}
              >
                Save changes
              </Button>
            </div>

            <div className="flex flex-col gap-3" aria-live="polite">
              <FormStatus
                className="empty:-mb-3 empty:min-h-0"
                status={aiStatus ? (aiStatus.ok ? "ok" : "fail") : undefined}
              >
                {aiStatus?.message}
              </FormStatus>

              {connectionResult &&
                (connectionResult.error ? (
                  <Alert status="fail">
                    <AlertTitle>{connectionResult.error}</AlertTitle>
                  </Alert>
                ) : (
                  <DataList>
                    <DataListItem>
                      <DataListLabel>Chat</DataListLabel>
                      <DataListValue>
                        <Status status={connectionResult.chat?.ok ? "ok" : "fail"} />{" "}
                        {connectionResult.chat?.ok
                          ? connectionResult.chat.message
                          : connectionResult.chat?.error}
                      </DataListValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListLabel>Embeddings</DataListLabel>
                      <DataListValue>
                        <Status
                          status={connectionResult.embeddings?.ok ? "ok" : "fail"}
                        />{" "}
                        {connectionResult.embeddings?.ok
                          ? connectionResult.embeddings.message
                          : connectionResult.embeddings?.error}
                      </DataListValue>
                    </DataListItem>
                  </DataList>
                ))}
            </div>
          </Section>

          <Section
            title="Storage"
            description="Where Atlas keeps its database and cloned repositories."
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={loadStorage}
                pending={isLoadingStorage}
                pendingLabel="Reading"
              >
                Refresh
              </Button>
            }
          >
            {storageError && <FormStatus status="fail">{storageError}</FormStatus>}

            <DataList>
              <DataListItem>
                <DataListLabel>Data folder</DataListLabel>
                <DataListValue>
                  <div className="flex w-full items-center gap-2">
                    <Input
                      mode="copy"
                      size="sm"
                      aria-label="Data folder path"
                      noun="data folder path"
                      value={storage?.dataPath ?? "Loading…"}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleOpenStorage}
                      disabled={!storage}
                    >
                      <Icon icon={External} />
                      Open folder
                    </Button>
                  </div>
                </DataListValue>
              </DataListItem>
              <DataListItem>
                <DataListLabel>Database</DataListLabel>
                <DataListValue className="tabular-nums">
                  {storage ? formatBytes(storage.databaseBytes) : "…"}
                </DataListValue>
              </DataListItem>
              <DataListItem>
                <DataListLabel>Cloned repositories</DataListLabel>
                <DataListValue className="tabular-nums">
                  {storage
                    ? `${formatBytes(storage.repositoriesBytes)} · ${
                        storage.repositoryCount
                      } ${
                        storage.repositoryCount === 1
                          ? "repository"
                          : "repositories"
                      }`
                    : "…"}
                </DataListValue>
              </DataListItem>
            </DataList>
          </Section>
        </div>
      </div>
    </div>
  );
}
