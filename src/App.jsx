import { HashRouter as Router, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import { Button } from "@/components/ui/button";
import {
  Settings,
  MoreHorizontal,
  Sparkles,
  Folder,
  ChevronDown,
  Plus,
  ArrowUp,
  GitBranch,
} from "lucide-react";

function MainArea() {
  return (
    <main className="flex-1 flex flex-col bg-background h-full overflow-hidden">
      {/* Topbar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <h1 className="text-sm font-medium text-foreground">New thread</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="w-5 h-5" />
          </Button>
        </div>
      </header>

      {/* Content area */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 overflow-y-auto">
        <div className="w-16 h-16 rounded-full bg-accent/40 flex items-center justify-center mb-6">
          <Sparkles className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-3xl font-bold text-foreground mb-8 tracking-tight">
          Let's build
        </h2>
        <Button
          variant="outline"
          className="rounded-full flex items-center gap-2 px-6 h-10 border-border text-muted-foreground hover:text-foreground"
        >
          <Folder className="w-4 h-4" />
          <span className="font-medium">project-atlas</span>
          <ChevronDown className="w-4 h-4 ml-1 opacity-70" />
        </Button>
      </div>

      {/* Chat Input Area */}
      <div className="w-full max-w-[640px] mx-auto px-6 pb-8 flex-shrink-0">
        <div className="relative flex flex-col bg-card border border-border rounded-lg overflow-hidden focus-within:border-foreground/30 transition-colors shadow-sm">
          <textarea
            placeholder="Ask anything"
            className="w-full min-h-[120px] p-4 bg-transparent resize-none outline-none text-foreground placeholder:text-muted-foreground text-base"
          />
          <div className="flex items-center justify-between p-3 pt-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <Plus className="w-5 h-5" />
            </Button>
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 rounded-lg shadow-none"
            >
              <ArrowUp className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Below input status bar */}
        <div className="flex items-center justify-between mt-4 px-2">
          <div className="flex items-center gap-6 text-sm font-medium">
            <button className="text-foreground underline underline-offset-8 decoration-2 decoration-border">
              Local
            </button>
            <button className="text-muted-foreground hover:text-foreground transition-colors">
              Worktree
            </button>
            <button className="text-muted-foreground hover:text-foreground transition-colors">
              Cloud
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="w-4 h-4 opacity-70" />
            <span>main</span>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <Router>
        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans antialiased selection:bg-accent selection:text-foreground">
          <Sidebar />
          <Routes>
            <Route path="*" element={<MainArea />} />
          </Routes>
        </div>
      </Router>
    </TooltipProvider>
  );
}
