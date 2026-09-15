import { GitBranch } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useNavigate, useLocation } from "react-router-dom";

function getRepositoryDescription(repository) {
  try {
    return new URL(repository.url).hostname;
  } catch {
    return repository.localPath || "Indexed repository";
  }
}

export default function Sidebar({
  repositories = [],
  selectedRepositoryId,
  onSelectRepository,
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const isActiveRepository = (repository) =>
    selectedRepositoryId === repository.id && location.pathname !== "/";

  return (
    <aside className="flex w-[240px] flex-shrink-0 flex-col border-e border-sidebar-border bg-sidebar">
      <div className="flex items-center px-5 py-4">
        <span className="text-xl font-semibold tracking-tight text-sidebar-foreground">
          Atlas
        </span>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => {
            onSelectRepository(null);
            navigate("/");
          }}
          className="flex min-h-10 w-full items-center gap-3 rounded-none px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
        >
          <GitBranch className="size-4" />
          Add repository
        </button>
      </div>

      <Separator className="mx-4" />

      <div className="px-5 pb-2 pt-4">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Repositories
        </h2>
      </div>

      <ScrollArea className="flex-1 px-3 pb-4">
        <div className="flex flex-col gap-1">
          {repositories.length === 0 && (
            <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Indexed repositories will appear here.
            </p>
          )}
          {repositories.map((repository) => {
            const active = isActiveRepository(repository);

            return (
              <button
                key={repository.id}
                type="button"
                onClick={() => {
                  onSelectRepository(repository.id);
                  navigate("/repo?tab=overview");
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-12 w-full items-center overflow-hidden rounded-none px-3 py-2 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {repository.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {getRepositoryDescription(repository)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
