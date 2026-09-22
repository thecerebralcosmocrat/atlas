import { useState } from "react";
import { Check, ChevronsUpDown, GitBranch, Layers, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useNavigate, useLocation } from "react-router-dom";

const workspaces = [
  {
    name: "Personal",
    description: "Local projects and experiments",
  },
  {
    name: "Work",
    description: "Shared team repositories",
  },
  {
    name: "Archive",
    description: "Older indexed projects",
  },
];

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
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspaces[0]);

  const isActiveRepository = (repository) =>
    selectedRepositoryId === repository.id && location.pathname !== "/";

  return (
    <aside className="flex min-h-0 w-[240px] flex-shrink-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar">
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

      <ScrollArea className="min-h-0 flex-1 px-3 pb-4">
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

      <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-sidebar-border p-3">
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-3 rounded-none px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
        >
          <Settings className="size-4" />
          Settings
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group/workspace flex min-h-12 w-full items-center gap-3 rounded-none px-3 py-2 text-start text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground"
            >
              <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-none bg-sidebar-primary text-sidebar-primary-foreground">
                <Layers className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <span className="truncate text-sm font-medium text-sidebar-foreground">
                  {selectedWorkspace.name}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  Workspace
                </span>
              </span>
              <ChevronsUpDown className="size-4 flex-shrink-0 transition-transform duration-200 ease-out group-data-[state=open]/workspace:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8}>
            <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {workspaces.map((workspace) => {
                const active = workspace.name === selectedWorkspace.name;

                return (
                  <DropdownMenuItem
                    key={workspace.name}
                    onSelect={() => setSelectedWorkspace(workspace)}
                    className="min-h-14 gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {workspace.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {workspace.description}
                      </span>
                    </span>
                    <Check
                      className={cn(
                        "flex-shrink-0 transition-[opacity,transform,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
                        active
                          ? "scale-100 opacity-100 blur-0"
                          : "scale-[0.25] opacity-0 blur-[4px]",
                      )}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
