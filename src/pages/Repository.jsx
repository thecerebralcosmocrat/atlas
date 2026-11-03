import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import RepoNav from "@/components/RepoNav";
import StartHerePanel from "@/components/StartHerePanel";
import RepositoryChat from "@/components/RepositoryChat";
import FileTree from "@/components/FileTree";
import CodeGraphPanel from "@/components/CodeGraphPanel";
import ImpactPanel from "@/components/ImpactPanel";
import OwnershipPanel from "@/components/OwnershipPanel";
import { Button } from "@/components/glaze/ui/button";
import { Icon, Retry } from "@/components/glaze/icon";
import { Alert, AlertTitle, AlertAction } from "@/components/glaze/ui/alert";
import {
  DataList,
  DataListItem,
  DataListLabel,
  DataListValue,
} from "@/components/glaze/ui/data-list";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/glaze/ui/empty-state";
import { Skeleton } from "@/components/glaze/ui/skeleton";
import { Truncate } from "@/components/glaze/ui/truncate";
import { formatDate } from "@/lib/format";

const VALID_TABS = ["overview", "ask", "files", "graph", "analyze"];

function Overview({ repository, selectedDetails }) {
  return (
    <div className="grid gap-4">
      <DataList>
        <DataListItem>
          <DataListLabel>Files</DataListLabel>
          <DataListValue>{selectedDetails?.fileCount ?? "-"}</DataListValue>
        </DataListItem>
        <DataListItem>
          <DataListLabel>Folders</DataListLabel>
          <DataListValue>{selectedDetails?.directoryCount ?? "-"}</DataListValue>
        </DataListItem>
        <DataListItem>
          <DataListLabel>Added</DataListLabel>
          <DataListValue>{formatDate(repository.addedAt)}</DataListValue>
        </DataListItem>
        <DataListItem>
          <DataListLabel>Last updated</DataListLabel>
          <DataListValue>{formatDate(repository.indexedAt)}</DataListValue>
        </DataListItem>
      </DataList>
      <StartHerePanel repository={repository} />
    </div>
  );
}

export default function Repository({
  repositories,
  selectedRepository,
  selectedDetails,
  isInspecting,
  chats,
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
        <Empty variant="plain">
          <EmptyHeader>
            <EmptyTitle>No repositories yet</EmptyTitle>
            <EmptyDescription>
              Add a GitHub repository to clone it locally and start exploring its
              files.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => navigate("/")}>Add repository</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const repository = selectedRepository || repositories[0];

  if (!repository) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty variant="plain">
          <EmptyHeader>
            <EmptyTitle>Choose a repository</EmptyTitle>
            <EmptyDescription>Select a repository from the sidebar.</EmptyDescription>
          </EmptyHeader>
        </Empty>
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
          <div className="min-w-0 max-w-2xl">
            <h1 className="type-title text-text-1">{repository.name}</h1>
            <div className="mt-1 text-text-2 type-body-sm">
              <Truncate>{repository.url}</Truncate>
            </div>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleSync}
            pending={isSyncing}
            pendingLabel="Refreshing"
            disabled={isDiscarding || !repository.url}
            title={
              repository.url
                ? "Check the remote for new commits"
                : "This repository has no remote to check"
            }
          >
            <Icon icon={Retry} />
            Refresh now
          </Button>
        </div>

        {syncError && (
          <p className="mt-3 type-body-sm text-fail-text" role="status">
            {syncError}
          </p>
        )}

        {!syncError && syncNotice && (
          <p className="mt-3 type-body-sm text-text-2" role="status">
            {syncNotice}
          </p>
        )}

        {repository.syncState === "dirty" && (
          <Alert status="warn" className="mt-3">
            <AlertTitle>
              Local changes in this clone are keeping it from updating.
            </AlertTitle>
            <AlertAction>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDiscardChanges}
                pending={isDiscarding}
                pendingLabel="Discarding"
                disabled={isSyncing}
              >
                Discard changes and sync
              </Button>
            </AlertAction>
          </Alert>
        )}
      </header>

      <RepoNav active={tab} onChange={setTab} />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className={tab === "ask" ? "h-full min-w-0" : "min-w-0"}>
          {tab === "overview" && (
            <Overview
              repository={repository}
              selectedDetails={selectedDetails}
            />
          )}
          {tab === "ask" && (
            <RepositoryChat
              repository={repository}
              chat={chats.get(repository.id)}
              onDraftChange={chats.setDraft}
              onAsk={chats.ask}
              onStop={chats.stop}
            />
          )}
          {tab === "files" && (
            <div className="border border-line-faint">
              {isInspecting ? (
                <div className="grid gap-2 p-3" role="status" aria-label="Reading repository files">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/5" />
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
