import { useEffect, useMemo, useState } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import Onboarding from "./pages/Onboarding";
import Repository from "./pages/Repository";

function getRepositoryApi() {
  return window.electronAPI?.repositories;
}

export default function App() {
  const [repositories, setRepositories] = useState([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  // Bumped when the main process finishes indexing repositories in the
  // background, which re-runs the list + inspect effects below.
  const [refreshToken, setRefreshToken] = useState(0);
  const repositoryApi = useMemo(getRepositoryApi, []);

  useEffect(() => {
    async function loadRepositories() {
      if (!repositoryApi) return;

      const storedRepositories = await repositoryApi.list();
      setRepositories(storedRepositories);

      if (storedRepositories.length > 0) {
        setSelectedRepositoryId(
          (currentId) => currentId || storedRepositories[0].id,
        );
      }
    }

    loadRepositories();
  }, [repositoryApi, refreshToken]);

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

  return (
    <TooltipProvider>
      <Router>
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-background font-sans text-foreground antialiased selection:bg-accent selection:text-foreground">
          {/* Custom titlebar drag region */}
          <div
            className="shrink-0 w-full h-8 border-b border-sidebar-border bg-sidebar"
            style={{ WebkitAppRegion: "drag" }}
          />

          <div className="flex flex-1 overflow-hidden">
            <Sidebar
              repositories={repositories}
              selectedRepositoryId={selectedRepositoryId}
              onSelectRepository={setSelectedRepositoryId}
            />

            <main className="flex flex-1 flex-col overflow-hidden bg-background">
              <Routes>
                <Route
                  path="/"
                  element={<Onboarding onAddRepository={handleAddRepository} />}
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
