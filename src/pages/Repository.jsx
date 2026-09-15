import { useNavigate, useSearchParams } from "react-router-dom";
import RepoNav from "@/components/RepoNav";
import StartHerePanel from "@/components/StartHerePanel";
import RepositoryChat from "@/components/RepositoryChat";
import FileTree from "@/components/FileTree";
import CodeGraphPanel from "@/components/CodeGraphPanel";
import ImpactPanel from "@/components/ImpactPanel";
import OwnershipPanel from "@/components/OwnershipPanel";
import { Button } from "@/components/ui/button";
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
      <div className="grid grid-cols-1 divide-y divide-border border border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat value={selectedDetails?.fileCount ?? "-"} label="Files" />
        <Stat value={selectedDetails?.directoryCount ?? "-"} label="Folders" />
        <Stat value={formatDate(repository.addedAt)} label="Indexed" />
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
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") ?? "overview";
  const tab = VALID_TABS.includes(rawTab) ? rawTab : "overview";

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

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="shrink-0 px-4 pb-3 pt-4">
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
      </header>

      <RepoNav active={tab} onChange={setTab} />

      <div className="flex-1 overflow-y-auto p-4">
        <div>
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
            <div className="grid gap-4 lg:grid-cols-2">
              <ImpactPanel key={repository.id} repository={repository} />
              <OwnershipPanel key={repository.id} repository={repository} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
