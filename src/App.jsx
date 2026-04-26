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
        <div className="w-16 h-16 rounded-full bg-accent/40 flex items-center justify-center mb-6">
          <GitBranch className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-3xl font-bold text-foreground mb-2 tracking-tight">
          Index a repository
        </h2>
        <p className="text-muted-foreground mb-8">
          Paste a GitHub URL to get started
        </p>
      </div>

      {/* URL Input Area */}
      <div className="w-full max-w-[640px] pb-8 flex-shrink-0 mx-auto">
        <div className="relative flex items-center bg-card border border-border rounded-lg focus-within:border-foreground/30 transition-colors shadow-sm overflow-hidden h-14">
          <div className="pl-4 pr-3 text-muted-foreground flex items-center justify-center">
            <LinkIcon className="w-5 h-5" />
          </div>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/user/repo"
            className="flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground text-base h-full w-full"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleIndex();
            }}
          />
          <div className="pr-2 flex items-center h-full">
            <Button variant="default" onClick={handleIndex}>
              Index
            </Button>
          </div>
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans antialiased selection:bg-accent selection:text-foreground">
      <Sidebar />
      <main className="flex-1 flex flex-col bg-background h-full overflow-hidden">
        {/* Topbar */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0 bg-background">
          <h1 className="text-sm font-medium text-foreground">{title}</h1>
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
