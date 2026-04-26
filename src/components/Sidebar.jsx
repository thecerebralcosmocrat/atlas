import {
  Map,
  PlusSquare,
  Zap,
  BrainCircuit,
  Folder,
  ChevronDown,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function Sidebar() {
  return (
    <aside className="w-[260px] bg-card flex flex-col border-r border-border h-full flex-shrink-0">
      {/* Sidebar header */}
      <div className="flex items-center gap-3 px-6 py-5 text-foreground">
        <Map className="w-5 h-5" />
        <span className="font-semibold text-lg tracking-tight">Atlas</span>
      </div>

      {/* Navigation links */}
      <div className="px-3 pb-4 space-y-1 text-muted-foreground">
        <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors">
          <PlusSquare className="w-4 h-4" />
          <span className="text-sm font-medium">New thread</span>
        </div>
        <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors">
          <Zap className="w-4 h-4" />
          <span className="text-sm font-medium">Automations</span>
        </div>
        <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors">
          <BrainCircuit className="w-4 h-4" />
          <span className="text-sm font-medium">Skills</span>
        </div>
      </div>

      {/* Separator */}
      <Separator className="mx-6 w-auto" />

      {/* Section label */}
      <div className="px-6 py-4">
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Threads
        </h3>
      </div>

      {/* Project + thread list */}
      <ScrollArea className="flex-1 px-3 pb-4">
        <div className="space-y-4">
          {/* Project Group 1 */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-3 py-1.5 text-foreground cursor-pointer hover:bg-accent rounded-md transition-colors group">
              <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <Folder className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm font-medium">project-atlas</span>
            </div>

            <div className="pl-9 pr-2 space-y-0.5">
              <div className="flex items-center gap-2 py-1.5 px-2 cursor-pointer text-muted-foreground hover:bg-accent/50 hover:text-foreground rounded-md transition-colors">
                <div className="w-1.5 h-1.5 rounded-full bg-transparent flex-shrink-0"></div>
                <span className="text-sm truncate">
                  Implement shadcn UI components
                </span>
              </div>
              <div className="flex items-center gap-2 py-1.5 px-2 cursor-pointer text-foreground bg-accent/30 rounded-md transition-colors">
                {/* Active indicator */}
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0"></div>
                <span className="text-sm truncate">
                  Sidebar and Layout design
                </span>
              </div>
              <div className="flex items-center gap-2 py-1.5 px-2 cursor-pointer text-muted-foreground hover:bg-accent/50 hover:text-foreground rounded-md transition-colors">
                <div className="w-1.5 h-1.5 rounded-full bg-transparent flex-shrink-0"></div>
                <span className="text-sm truncate">
                  Fix routing bug in App.jsx
                </span>
              </div>
            </div>
          </div>

          {/* Project Group 2 */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-3 py-1.5 text-foreground cursor-pointer hover:bg-accent rounded-md transition-colors group">
              <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <Folder className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm font-medium">personal-website</span>
            </div>

            <div className="pl-9 pr-2 space-y-0.5">
              <div className="flex items-center gap-2 py-1.5 px-2 cursor-pointer text-muted-foreground hover:bg-accent/50 hover:text-foreground rounded-md transition-colors">
                <div className="w-1.5 h-1.5 rounded-full bg-transparent flex-shrink-0"></div>
                <span className="text-sm truncate">Update blog layout</span>
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}
