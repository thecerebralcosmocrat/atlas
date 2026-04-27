import { useState, useRef, useEffect } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import { Button } from "@/components/ui/button";
import {
  Settings,
  MoreHorizontal,
  GitBranch,
  Link as LinkIcon,
  Plus,
  ArrowUp,
  Globe,
  BookOpen,
  Info,
} from "lucide-react";

function Home() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-foreground">Home</h1>
    </div>
  );
}

function Explorer() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-foreground">Explorer</h1>
    </div>
  );
}

function Onboarding() {
  const [url, setUrl] = useState("");
  const [isIndexing, setIsIndexing] = useState(false);
  const [logs, setLogs] = useState([]);
  const logContainerRef = useRef(null);

  const handleIndex = () => {
    if (!url.trim()) return;
    setIsIndexing(true);
    setLogs((prev) => [...prev, `Connecting to repository: ${url}`]);

    // Mock indexing steps for visual feedback
    setTimeout(
      () => setLogs((prev) => [...prev, "Cloning branch 'main'..."]),
      800,
    );
    setTimeout(
      () => setLogs((prev) => [...prev, "Resolving dependencies..."]),
      1600,
    );
    setTimeout(
      () =>
        setLogs((prev) => [
          ...prev,
          "Extracting AST and semantic structures...",
        ]),
      2400,
    );
    setTimeout(
      () =>
        setLogs((prev) => [
          ...prev,
          "Generating vector embeddings for search...",
        ]),
      3500,
    );
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="flex-1 flex flex-col items-center justify-between p-6 overflow-y-auto">
      {/* Centered Empty State */}
      <div className="flex-1 flex flex-col items-center justify-center w-full">
        <h2 className="text-3xl font-aleo font-bold text-foreground mb-2 tracking-tight">
          Index a repository
        </h2>
        <p className="text-muted-foreground mb-8">
          Paste a GitHub URL to get started
        </p>
      </div>

      {/* URL Input Area */}
      <div className="w-full max-w-[680px] pb-8 flex-shrink-0 mx-auto">
        <div className="relative flex items-center bg-card border border-border rounded-full h-14 px-2">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full flex-shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Plus className="w-5 h-5" />
          </Button>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/user/repo"
            className="flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground text-base h-full px-3"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleIndex();
            }}
          />
          <div className="flex items-center gap-1 flex-shrink-0 pr-1">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground hover:text-foreground"
            >
              <LinkIcon className="w-5 h-5" />
            </Button>
            <Button
              variant="default"
              size="icon"
              className="rounded-full"
              onClick={handleIndex}
            >
              <ArrowUp className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Suggestion Chips */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
          <button className="flex items-center gap-2 rounded-full border border-border bg-transparent hover:bg-accent text-muted-foreground text-xs px-3 py-1.5 transition-colors">
            <Globe className="w-4 h-4" />
            <span>Try a public repo</span>
          </button>
          <button className="flex items-center gap-2 rounded-full border border-border bg-transparent hover:bg-accent text-muted-foreground text-xs px-3 py-1.5 transition-colors">
            <BookOpen className="w-4 h-4" />
            <span>Browse examples</span>
          </button>
          <button className="flex items-center gap-2 rounded-full border border-border bg-transparent hover:bg-accent text-muted-foreground text-xs px-3 py-1.5 transition-colors">
            <Info className="w-4 h-4" />
            <span>Learn more</span>
          </button>
        </div>

        {/* Progress Log */}
        {isIndexing && (
          <div
            ref={logContainerRef}
            className="mt-4 bg-card border border-border rounded-lg p-4 h-40 overflow-y-auto"
          >
            {logs.map((log, index) => (
              <div
                key={index}
                className="flex items-start gap-2 text-sm text-muted-foreground mb-1.5"
              >
                <span className="text-foreground leading-snug">•</span>
                <span className="leading-snug">{log}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Layout({ children }) {
  const location = useLocation();

  // Topbar title shows active repo name, falls back to "Atlas"
  const title = location.pathname === "/" ? "Atlas" : "project-atlas";
  const showTopbar = location.pathname !== "/";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans antialiased selection:bg-accent selection:text-foreground">
      {/* Custom Titlebar Drag Region */}
      <div
        className="absolute top-0 left-0 w-full h-8 z-50 pointer-events-none"
        style={{ WebkitAppRegion: "drag" }}
      />

      <Sidebar />
      <main className="flex-1 flex flex-col bg-background h-full overflow-hidden relative">
        {/* Topbar */}
        {showTopbar && (
          <header className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-border flex-shrink-0 bg-background">
            <h1 className="text-sm font-medium text-foreground">{title}</h1>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="w-5 h-5" />
              </Button>
            </div>
          </header>
        )}

        {/* Page Content */}
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <Router>
        <Layout>
          <Routes>
            <Route path="/" element={<Onboarding />} />
            <Route path="/home" element={<Home />} />
            <Route path="/explorer" element={<Explorer />} />
          </Routes>
        </Layout>
      </Router>
    </TooltipProvider>
  );
}
