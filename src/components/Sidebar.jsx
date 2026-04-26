import { useState } from "react";
import { Map, GitBranch, Database, ChevronDown, Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNavigate, useLocation } from "react-router-dom";

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isProjectAtlasOpen, setIsProjectAtlasOpen] = useState(true);

  const isActive = (path) => location.pathname === path;

  return (
    <aside className="w-[260px] bg-card flex flex-col border-r border-border h-full flex-shrink-0">
      {/* Sidebar header */}
      <div className="flex items-center gap-3 px-6 py-5 text-foreground">
        <Map className="w-5 h-5" />
        <span className="font-semibold text-lg tracking-tight">Atlas</span>
      </div>

      {/* Navigation links */}
      <div className="px-3 pb-4 space-y-1 text-muted-foreground">
        <div
          onClick={() => navigate("/")}
          className={`flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors ${
            isActive("/") ? "bg-accent text-foreground" : ""
          }`}
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
              className="flex items-center gap-2 px-3 py-1.5 text-foreground cursor-pointer hover:bg-accent rounded-md transition-colors group"
              onClick={() => setIsProjectAtlasOpen(!isProjectAtlasOpen)}
            >
              <ChevronDown
                className={`w-4 h-4 text-muted-foreground group-hover:text-foreground transition-transform ${isProjectAtlasOpen ? "" : "-rotate-90"}`}
              />
              <Database className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm font-medium">project-atlas</span>
            </div>

            {isProjectAtlasOpen && (
              <div className="pl-9 pr-2 space-y-0.5">
                <div
                  onClick={() => navigate("/home")}
                  className={`flex items-center gap-2 py-1.5 px-2 cursor-pointer rounded-md transition-colors ${
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
                  className={`flex items-center gap-2 py-1.5 px-2 cursor-pointer rounded-md transition-colors ${
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

      {/* Settings Bottom Area */}
      <div className="px-4 py-4 mt-auto border-t border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="w-5 h-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Settings</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
