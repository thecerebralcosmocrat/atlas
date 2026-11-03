import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Icon, Add, ChevronSort, More, Settings, TrashCan } from "@/components/glaze/icon";
import { Badge } from "@/components/glaze/ui/badge";
import { Button } from "@/components/glaze/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/glaze/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemLink,
  ItemTitle,
} from "@/components/glaze/ui/item";

function getRepositoryDescription(repository) {
  try {
    const { hostname, pathname } = new URL(repository.url);
    // owner/repo tells two clones of the same name apart; the host alone cannot.
    const path = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");

    return path || hostname;
  } catch {
    return repository.localPath || "Indexed repository";
  }
}

function countLabel(count) {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

function RepositoryRow({
  repository,
  active,
  onSelect,
  onRequestDeleteRepository,
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // The dialog holds itself open while the promise runs and shows a failure in
  // place, so a failed delete stays on screen with its message.
  const handleConfirmDelete = async () => {
    try {
      await onRequestDeleteRepository(repository.id);
    } catch (error) {
      throw new Error(error.message || "Could not delete this repository.");
    }
  };

  return (
    <>
      <Item selected={active}>
        <ItemContent>
          <ItemTitle>
            <ItemLink
              href="#/repo?tab=ask"
              aria-current={active ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onSelect();
              }}
            >
              {repository.name}
            </ItemLink>
          </ItemTitle>
          <ItemDescription className="truncate">
            {getRepositoryDescription(repository)}
          </ItemDescription>
          {repository.syncState === "dirty" && (
            <Badge variant="warn" size="sm">
              Local changes
            </Badge>
          )}
        </ItemContent>

        <ItemActions>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Actions for ${repository.name}`}
                />
              }
            >
              <Icon icon={More} size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" size="sm">
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  // Let the menu finish closing before the dialog opens,
                  // otherwise the menu's focus restoration steals focus back
                  // from it.
                  window.setTimeout(() => setIsConfirmOpen(true), 0)
                }
              >
                <Icon icon={TrashCan} />
                Delete repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </Item>

      <Dialog
        role="alertdialog"
        open={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete repository?</DialogTitle>
            <DialogDescription>
              This removes {repository.name} and everything indexed from it.
              Files cloned into Atlas are deleted from disk. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <DialogAction
              variant="destructive"
              onAction={handleConfirmDelete}
              pendingLabel="Deleting"
            >
              Delete
            </DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Sidebar({
  repositories = [],
  profiles = [],
  activeProfile = null,
  selectedRepositoryId,
  onSelectRepository,
  onSwitchProfile,
  onRequestDeleteRepository,
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const isActiveRepository = (repository) =>
    selectedRepositoryId === repository.id &&
    location.pathname !== "/add" &&
    location.pathname !== "/settings";
  const isSettingsActive = location.pathname === "/settings";

  return (
    <aside className="flex min-h-0 w-60 shrink-0 flex-col overflow-hidden border-e border-line-faint bg-shell">
      <div className="px-4 py-3">
        <span className="type-heading text-text-1">Atlas</span>
      </div>

      <div className="px-3 pb-3">
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            onSelectRepository(null);
            navigate("/add");
          }}
        >
          <Icon icon={Add} />
          Add repository
        </Button>
      </div>

      <div className="border-t border-line-faint px-4 pb-1 pt-3">
        <h2 className="type-label text-text-2">Repositories</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {repositories.length === 0 && (
          <p className="px-1 py-2 type-body-sm text-text-2">
            Indexed repositories will appear here.
          </p>
        )}
        {repositories.length > 0 && (
          <ItemGroup aria-label="Repositories">
            {repositories.map((repository) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                active={isActiveRepository(repository)}
                onSelect={() => {
                  onSelectRepository(repository.id);
                  navigate("/repo?tab=ask");
                }}
                onRequestDeleteRepository={onRequestDeleteRepository}
              />
            ))}
          </ItemGroup>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line-faint p-3">
        <Button
          render={
            <a
              href="#/settings"
              aria-current={isSettingsActive ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate("/settings");
              }}
            />
          }
          nativeButton={false}
          variant={isSettingsActive ? "secondary" : "ghost"}
          className="w-full justify-start"
        >
          <Icon icon={Settings} />
          Settings
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="secondary" className="w-full justify-between" />
            }
          >
            <span className="min-w-0 truncate">
              {activeProfile?.name ?? "Profile"}
            </span>
            <Icon icon={ChevronSort} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Switch profile</DropdownMenuLabel>
              {profiles.length === 0 && (
                <DropdownMenuItem disabled>Loading profiles…</DropdownMenuItem>
              )}
              <DropdownMenuRadioGroup
                value={activeProfile?.id ?? null}
                onValueChange={(profileId) => onSwitchProfile(profileId)}
              >
                {profiles.map((profile) => (
                  <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                    <span className="min-w-0">
                      <span className="block truncate">{profile.name}</span>
                      <span className="block truncate type-caption text-text-2">
                        {profile.description
                          ? `${profile.description} · ${countLabel(profile.repositoryCount)}`
                          : countLabel(profile.repositoryCount)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLinkItem
              href="#/settings"
              onClick={(event) => {
                event.preventDefault();
                navigate("/settings");
              }}
            >
              Manage profiles
            </DropdownMenuLinkItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
