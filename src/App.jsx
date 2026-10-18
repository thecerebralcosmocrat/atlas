import { useEffect, useMemo, useRef, useState } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import Onboarding from "./pages/Onboarding";
import Repository from "./pages/Repository";
import Settings from "./pages/Settings";

function getRepositoryApi() {
  return window.electronAPI?.repositories;
}

function getSettingsApi() {
  return window.electronAPI?.settings;
}

function getProfileApi() {
  return window.electronAPI?.profiles;
}

export default function App() {
  const [repositories, setRepositories] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [settings, setSettings] = useState(null);
  // Bumped when the main process finishes indexing repositories in the
  // background, which re-runs the list + inspect effects below.
  const [refreshToken, setRefreshToken] = useState(0);
  const repositoryApi = useMemo(getRepositoryApi, []);
  const settingsApi = useMemo(getSettingsApi, []);
  const profileApi = useMemo(getProfileApi, []);

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      if (!settingsApi) return;

      try {
        const storedSettings = await settingsApi.get();

        if (active) setSettings(storedSettings);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    }

    loadSettings();

    return () => {
      active = false;
    };
  }, [settingsApi]);

  useEffect(() => {
    if (!settingsApi?.onChanged) return undefined;

    return settingsApi.onChanged((updatedSettings) =>
      setSettings(updatedSettings),
    );
  }, [settingsApi]);

  useEffect(() => {
    let active = true;

    async function loadProfiles() {
      if (!profileApi) return;

      try {
        const storedProfiles = await profileApi.list();

        // The main process reloaded the list from SQLite, so the counts are
        // current; this is also how a move or delete updates the switcher.
        if (active) setProfiles(storedProfiles);
      } catch (error) {
        console.error("Failed to load profiles:", error);
      }
    }

    loadProfiles();

    const unsubscribe = profileApi?.onChanged?.(loadProfiles);

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [profileApi, refreshToken]);

  // The configured id can be stale (the profile was deleted on another
  // launch), so trust the database list and fall back to the default, which
  // listProfiles returns first.
  const configuredProfileId = settings?.general?.activeProfileId ?? null;
  const activeProfile =
    profiles.find((profile) => profile.id === configuredProfileId) ??
    profiles[0] ??
    null;
  // Read inside async handlers, which may resolve after the user switches
  // profiles; state captured at call time would be stale by then.
  const activeProfileIdRef = useRef(null);

  useEffect(() => {
    activeProfileIdRef.current = activeProfile?.id ?? null;
  }, [activeProfile?.id]);

  // The main process keeps the native titlebar and native surfaces in step;
  // the renderer owns the class that swaps the CSS variables.
  useEffect(() => {
    const theme = settings?.general?.theme ?? "system";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const dark = theme === "dark" || (theme === "system" && prefersDark.matches);
      document.documentElement.classList.toggle("dark", dark);
    };

    applyTheme();

    if (theme !== "system") return undefined;

    prefersDark.addEventListener("change", applyTheme);

    return () => prefersDark.removeEventListener("change", applyTheme);
  }, [settings?.general?.theme]);

  useEffect(() => {
    async function loadRepositories() {
      if (!repositoryApi) return;

      // The main process scopes this to the active profile. Switching
      // profiles therefore re-reads the list and cannot leave a repository
      // from the previous profile selected.
      const storedRepositories = await repositoryApi.list();
      setRepositories(storedRepositories);
      setSelectedRepositoryId((currentId) => {
        const stillListed = storedRepositories.some(
          (repository) => repository.id === currentId,
        );

        return stillListed ? currentId : (storedRepositories[0]?.id ?? null);
      });
    }

    loadRepositories();
  }, [repositoryApi, refreshToken, activeProfile?.id]);

  useEffect(() => {
    if (!repositoryApi?.onChanged) return undefined;

    return repositoryApi.onChanged(() =>
      setRefreshToken((currentToken) => currentToken + 1),
    );
  }, [repositoryApi]);

  useEffect(() => {
    async function inspectSelectedRepository() {
      if (!repositoryApi || !selectedRepositoryId) {
        setSelectedDetails(null);
        return;
      }

      setIsInspecting(true);

      try {
        setSelectedDetails(await repositoryApi.inspect(selectedRepositoryId));
      } finally {
        setIsInspecting(false);
      }
    }

    inspectSelectedRepository();
  }, [repositoryApi, selectedRepositoryId, refreshToken]);

  const selectedRepository =
    repositories.find((repository) => repository.id === selectedRepositoryId) ||
    null;

  const handleAddRepository = async (repositoryUrl) => {
    if (!repositoryApi) {
      throw new Error(
        "Repository indexing is only available in the Electron app.",
      );
    }

    const repository = await repositoryApi.add(repositoryUrl);

    // Indexing can take a while. If the profile changed in the meantime, the
    // repository belongs to the profile that was active when the add began,
    // so reload the scoped list instead of injecting it into the current one.
    if (repository.workspaceId !== activeProfileIdRef.current) {
      setRefreshToken((currentToken) => currentToken + 1);

      return repository;
    }

    setRepositories((currentRepositories) => [
      repository,
      ...currentRepositories.filter((item) => item.id !== repository.id),
    ]);
    setSelectedRepositoryId(repository.id);
    setSelectedDetails(repository);

    return repository;
  };

  const handleAskRepository = async (repositoryId, question) => {
    if (!repositoryApi) {
      throw new Error("Repository Q&A is only available in the Electron app.");
    }

    return repositoryApi.ask(repositoryId, question);
  };

  const handleSyncRepository = async (repositoryId) => {
    if (!repositoryApi) {
      throw new Error("Repository sync is only available in the Electron app.");
    }

    const result = await repositoryApi.sync(repositoryId);

    // The main process re-indexes in place; re-reading the list + inspect pulls
    // the refreshed file count and sync state into the UI.
    if (result.changed) {
      setRefreshToken((currentToken) => currentToken + 1);
    }

    return result;
  };

  const handleDiscardRepositoryChanges = async (repositoryId) => {
    if (!repositoryApi) {
      throw new Error("Repository sync is only available in the Electron app.");
    }

    const details = await repositoryApi.discardChanges(repositoryId);
    setRefreshToken((currentToken) => currentToken + 1);

    return details;
  };

  const handleUpdateSettings = async (patch) => {
    if (!settingsApi) {
      throw new Error("Settings are only available in the Electron app.");
    }

    const updatedSettings = await settingsApi.set(patch);
    setSettings(updatedSettings);

    return updatedSettings;
  };

  const handleSwitchProfile = async (profileId) => {
    if (profileId === activeProfile?.id) return;

    if (!profileApi?.switch) {
      throw new Error("Profiles are only available in the Electron app.");
    }

    // The main process persists the selection and switches the repositories,
    // theme, sync policy and AI configuration together, then returns the new
    // profile's settings so the renderer never shows one profile's repositories
    // under another's configuration.
    const updatedSettings = await profileApi.switch(profileId);
    setSettings(updatedSettings);
    setRefreshToken((currentToken) => currentToken + 1);
  };

  const handleMoveRepository = async (repositoryId, profileId) => {
    if (!repositoryApi?.move) {
      throw new Error("Profiles are only available in the Electron app.");
    }

    return repositoryApi.move(repositoryId, profileId);
  };

  const handleCreateProfile = async (profile) => {
    if (!profileApi) {
      throw new Error("Profiles are only available in the Electron app.");
    }

    return profileApi.create(profile);
  };

  const handleUpdateProfile = async (profileId, patch) => {
    if (!profileApi) {
      throw new Error("Profiles are only available in the Electron app.");
    }

    return profileApi.update(profileId, patch);
  };

  const handleDeleteProfile = async (profileId) => {
    if (!profileApi) {
      throw new Error("Profiles are only available in the Electron app.");
    }

    return profileApi.remove(profileId);
  };

  const handleDeleteRepository = async (repositoryId) => {
    if (!repositoryApi) {
      throw new Error(
        "Repository deletion is only available in the Electron app.",
      );
    }

    await repositoryApi.remove(repositoryId);

    const remainingRepositories = repositories.filter(
      (repository) => repository.id !== repositoryId,
    );
    setRepositories(remainingRepositories);

    // The deleted repository may be the one on screen; fall back to another so
    // the page keeps showing a repository instead of an empty selection.
    if (selectedRepositoryId === repositoryId) {
      setSelectedRepositoryId(remainingRepositories[0]?.id ?? null);
      setSelectedDetails(null);
    }
  };

  return (
    <TooltipProvider>
      <Router>
        <div className="flex h-full w-full flex-col overflow-hidden bg-background font-sans text-foreground antialiased selection:bg-accent selection:text-foreground">
          {/* Custom titlebar drag region */}
          <div
            className="shrink-0 w-full h-8 border-b border-sidebar-border bg-sidebar"
            style={{ WebkitAppRegion: "drag" }}
          />

          <div className="flex flex-1 overflow-hidden">
            <Sidebar
              repositories={repositories}
              profiles={profiles}
              activeProfile={activeProfile}
              selectedRepositoryId={selectedRepositoryId}
              onSelectRepository={setSelectedRepositoryId}
              onSwitchProfile={handleSwitchProfile}
              onMoveRepository={handleMoveRepository}
              onRequestDeleteRepository={handleDeleteRepository}
            />

            <main className="flex flex-1 flex-col overflow-hidden bg-background">
              <Routes>
                <Route
                  path="/"
                  element={<Onboarding onAddRepository={handleAddRepository} />}
                />
                <Route
                  path="/settings"
                  element={
                    <Settings
                      settings={settings}
                      profiles={profiles}
                      onUpdateSettings={handleUpdateSettings}
                      onCreateProfile={handleCreateProfile}
                      onUpdateProfile={handleUpdateProfile}
                      onDeleteProfile={handleDeleteProfile}
                    />
                  }
                />
                <Route
                  path="/repo"
                  element={
                    <Repository
                      repositories={repositories}
                      selectedRepository={selectedRepository}
                      selectedDetails={selectedDetails}
                      isInspecting={isInspecting}
                      onAskRepository={handleAskRepository}
                      onSyncRepository={handleSyncRepository}
                      onDiscardRepositoryChanges={
                        handleDiscardRepositoryChanges
                      }
                    />
                  }
                />
              </Routes>
            </main>
          </div>
        </div>
      </Router>
    </TooltipProvider>
  );
}
