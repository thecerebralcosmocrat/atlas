import { useState } from "react";
import { GitBranch, Folder, ChevronDown, Settings, User } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNavigate, useLocation } from "react-router-dom";

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isProjectAtlasOpen, setIsProjectAtlasOpen] = useState(true);

  const isActive = (path) => location.pathname === path;

  return (
    <aside className="w-[260px] bg-card flex flex-col border border-border h-[calc(100vh-16px)] m-2 rounded-xl flex-shrink-0 overflow-hidden">
      {/* Sidebar header */}
      <div className="flex items-center gap-3 px-6 py-5 text-foreground">
        <span className="font-product font-semibold text-2xl tracking-tight">
          Atlas
        </span>
      </div>

      {/* Navigation links */}
      <div className="px-3 pb-4 space-y-1 text-muted-foreground">
        <div
          onClick={() => navigate("/")}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors"
        >
          <GitBranch className="w-4 h-4" />
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

      {/* Project + thread list */}
      <ScrollArea className="flex-1 px-3 pb-4">
        <div className="space-y-4">
          {/* Example Repository Group */}
          <div className="space-y-1">
            <div
              className="flex items-center gap-2 px-3 py-2 text-foreground cursor-pointer hover:bg-accent rounded-lg transition-colors group"
              onClick={() => setIsProjectAtlasOpen(!isProjectAtlasOpen)}
            >
              <ChevronDown
                className={`w-4 h-4 text-muted-foreground group-hover:text-foreground transition-transform ${isProjectAtlasOpen ? "" : "-rotate-90"}`}
              />
              <Folder className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm font-medium">project-atlas</span>
            </div>

            {isProjectAtlasOpen && (
              <div className="pl-9 pr-2 space-y-0.5">
                <div
                  onClick={() => navigate("/home")}
                  className={`flex items-center gap-2 py-2 px-3 cursor-pointer rounded-lg transition-colors ${
                    isActive("/home")
                      ? "bg-accent/30 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  <div
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      isActive("/home") ? "bg-blue-500" : "bg-transparent"
                    }`}
                  ></div>
                  <span className="text-sm truncate">Home</span>
                </div>
                <div
                  onClick={() => navigate("/explorer")}
                  className={`flex items-center gap-2 py-2 px-3 cursor-pointer rounded-lg transition-colors ${
                    isActive("/explorer")
                      ? "bg-accent/30 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  <div
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      isActive("/explorer") ? "bg-blue-500" : "bg-transparent"
                    }`}
                  ></div>
                  <span className="text-sm truncate">Explorer</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Sidebar Footer */}
      <div className="mt-auto border-t border-border p-3 space-y-1">
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <Settings className="w-4 h-4" />
          <span className="text-sm font-medium">Settings</span>
        </div>
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
            <User className="w-4 h-4 text-primary" />
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-sm font-medium text-foreground truncate">
              Atlas User
            </span>
            <span className="text-[10px] text-muted-foreground truncate">
              Free Plan
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
