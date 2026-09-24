import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import RepoNav from "@/components/RepoNav";
import StartHerePanel from "@/components/StartHerePanel";
import RepositoryChat from "@/components/RepositoryChat";
import FileTree from "@/components/FileTree";
import CodeGraphPanel from "@/components/CodeGraphPanel";
import ImpactPanel from "@/components/ImpactPanel";
import OwnershipPanel from "@/components/OwnershipPanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

const VALID_TABS = ["overview", "ask", "files", "graph", "analyze"];

function Stat({ value, label }) {
  return (
    <div className="p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Overview({ repository, selectedDetails }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-1 divide-y divide-border border border-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <Stat value={selectedDetails?.fileCount ?? "-"} label="Files" />
        <Stat value={selectedDetails?.directoryCount ?? "-"} label="Folders" />
        <Stat value={formatDate(repository.addedAt)} label="Added" />
        <Stat value={formatDate(repository.indexedAt)} label="Last updated" />
      </div>
      <StartHerePanel repository={repository} />
    </div>
  );
}

export default function Repository({
  repositories,
  selectedRepository,
  selectedDetails,
  isInspecting,
  onAskRepository,
  onSyncRepository,
  onDiscardRepositoryChanges,
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const rawTab = searchParams.get("tab") ?? "overview";
  const tab = VALID_TABS.includes(rawTab) ? rawTab : "overview";
  // Sync feedback belongs to the repository it was produced for; switching
  // repositories must not carry a stale "up to date" notice across.
  const activeRepositoryId = selectedRepository?.id ?? repositories[0]?.id;

  useEffect(() => {
    setSyncError("");
    setSyncNotice("");
  }, [activeRepositoryId]);

  if (repositories.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            No repositories yet
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add a GitHub repository to clone it locally and start exploring its
            files.
          </p>
          <Button className="mt-6 rounded-none" onClick={() => navigate("/")}>
            Add repository
          </Button>
        </div>
      </div>
    );
  }

  const repository = selectedRepository || repositories[0];

  if (!repository) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            Choose a repository
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select a repository from the sidebar.
          </p>
        </div>
      </div>
    );
  }

  const setTab = (next) => setSearchParams({ tab: next }, { replace: true });

  const handleSync = async () => {
    if (!onSyncRepository) return;

    setIsSyncing(true);
    setSyncError("");
    setSyncNotice("");

    try {
      const result = await onSyncRepository(repository.id);

      if (result.status === "unreachable") {
        setSyncError("Could not reach the remote for this repository.");
      } else if (result.status === "skipped") {
        setSyncNotice(
          "Atlas did not clone this repository, so it is not updated automatically.",
        );
      } else if (result.status === "dirty") {
        setSyncNotice("Local changes are holding back an update.");
      } else if (result.status === "updated") {
        setSyncNotice("Updated from the remote.");
      } else {
        setSyncNotice("Already up to date.");
      }
    } catch (error) {
      setSyncError(error.message || "Could not refresh this repository.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDiscardChanges = async () => {
    if (!onDiscardRepositoryChanges) return;

    setIsDiscarding(true);
    setSyncError("");
    setSyncNotice("");

    try {
      await onDiscardRepositoryChanges(repository.id);
      setSyncNotice("Local changes discarded; the clone is level with the remote.");
    } catch (error) {
      setSyncError(error.message || "Could not discard local changes.");
    } finally {
      setIsDiscarding(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Repository
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.055em] text-foreground">
              {repository.name}
            </h1>
            <p
              className="mt-1 max-w-2xl truncate text-sm text-muted-foreground"
              title={repository.url}
            >
              {repository.url}
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={isSyncing || isDiscarding || !repository.url}
            title={
              repository.url
                ? "Check the remote for new commits"
                : "This repository has no remote to check"
            }
          >
            <RefreshCw className={cn("size-3.5", isSyncing && "animate-spin")} />
            {isSyncing ? "Refreshing…" : "Refresh now"}
          </Button>
        </div>

        {syncError && (
          <p className="mt-3 text-sm text-destructive">{syncError}</p>
        )}

        {!syncError && syncNotice && (
          <p className="mt-3 text-sm text-muted-foreground">{syncNotice}</p>
        )}

        {repository.syncState === "dirty" && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-sm text-destructive">
              Local changes in this clone are keeping it from updating.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDiscardChanges}
              disabled={isDiscarding || isSyncing}
            >
              {isDiscarding ? "Discarding…" : "Discard changes and sync"}
            </Button>
          </div>
        )}
      </header>

      <RepoNav active={tab} onChange={setTab} />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className="min-w-0">
          {tab === "overview" && (
            <Overview
              repository={repository}
              selectedDetails={selectedDetails}
            />
          )}
          {tab === "ask" && (
            <RepositoryChat
              repository={repository}
              onAskRepository={onAskRepository}
            />
          )}
          {tab === "files" && (
            <div className="border border-border">
              {isInspecting ? (
                <div className="p-3 text-sm text-muted-foreground">
                  Reading repository files...
                </div>
              ) : (
                <FileTree items={selectedDetails?.tree ?? []} />
              )}
            </div>
          )}
          {tab === "graph" && (
            <CodeGraphPanel key={repository.id} repository={repository} />
          )}
          {tab === "analyze" && (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
              <ImpactPanel key={repository.id} repository={repository} />
              <OwnershipPanel key={repository.id} repository={repository} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
