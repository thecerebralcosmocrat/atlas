import { useState } from "react";
import {
  Check,
  ChevronsUpDown,
  GitBranch,
  Layers,
  Settings,
} from "lucide-react";
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
    <aside className="m-2 flex h-[calc(100vh-16px)] w-[260px] flex-shrink-0 flex-col overflow-hidden rounded-[calc(10px-2px)] border border-sidebar-border bg-sidebar shadow-sm">
      {/* Sidebar header */}
      <div className="flex items-center gap-3 px-6 py-5 text-sidebar-foreground">
        <span className="font-product text-2xl font-semibold tracking-tight">
          Atlas
        </span>
      </div>

      {/* Navigation links */}
      <div className="flex flex-col gap-1 px-3 pb-4 text-muted-foreground">
        <div
          onClick={() => {
            onSelectRepository(null);
            navigate("/");
          }}
          className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[calc(var(--radius)+0.375rem)] px-3 py-2 transition-[background-color,color,box-shadow] duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent/80"
        >
          <GitBranch className="h-4 w-4" />
          <span className="text-sm font-medium">Add Repository</span>
        </div>
      </div>

      {/* Separator */}
      <Separator className="mx-6 w-auto" />

      {/* Section label */}
      <div className="px-6 py-4">
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Repositories
        </h3>
      </div>

      {/* Flat repository list */}
      <ScrollArea className="flex-1 px-3 pb-4">
        <div className="flex flex-col gap-1">
          {repositories.length === 0 && (
            <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Indexed repositories will appear here.
            </div>
          )}
          {repositories.map((repository) => {
            const active = isActiveRepository(repository);

            return (
              <div
                key={repository.id}
                onClick={() => {
                  onSelectRepository(repository.id);
                  navigate("/home");
                }}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center rounded-[calc(var(--radius)+0.5rem)] px-3 py-2 transition-[background-color,color,box-shadow] duration-150 ease-out active:bg-sidebar-accent/80",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
                )}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {repository.name}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {getRepositoryDescription(repository)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Sidebar Footer */}
      <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border p-3">
        <div className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[calc(var(--radius)+0.375rem)] px-3 py-2 text-muted-foreground transition-[background-color,color,box-shadow] duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent/80">
          <Settings className="h-4 w-4" />
          <span className="text-sm font-medium">Settings</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group/workspace flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[calc(var(--radius)+0.5rem)] px-2 py-2 text-left text-muted-foreground transition-[background-color,color,box-shadow] duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent/80 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground"
            >
              <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-[calc(var(--radius)+0.5rem)] bg-sidebar-primary text-sidebar-primary-foreground">
                <Layers className="h-4 w-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <span className="truncate text-sm font-medium text-sidebar-foreground">
                  {selectedWorkspace.name}
                </span>
                <span className="truncate text-[10px] text-muted-foreground">
                  Workspace
                </span>
              </div>
              <ChevronsUpDown className="h-4 w-4 flex-shrink-0 transition-transform duration-200 ease-out group-data-[state=open]/workspace:rotate-180" />
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
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {workspace.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {workspace.description}
                      </div>
                    </div>
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
