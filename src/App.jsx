import { useEffect, useMemo, useRef, useState } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  useNavigate,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import { Button } from "@/components/ui/button";
import {
  Link as LinkIcon,
  Plus,
  ArrowUp,
  Globe,
  BookOpen,
  Info,
} from "lucide-react";

function getRepositoryApi() {
  return window.electronAPI?.repositories;
}

function formatDate(value) {
  if (!value) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

const onboardingPrompts = [
  "What does this repo do?",
  "How do I run this?",
  "What should I read first?",
];

function RepositoryChat({ repository, onAskRepository }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [isAsking, setIsAsking] = useState(false);
  const messagesRef = useRef(null);

  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content:
          "Ask me onboarding questions about this codebase. I can help with the project overview, run commands, structure, and where to start reading.",
      },
    ]);
    setQuestion("");
  }, [repository?.id]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const askQuestion = async (nextQuestion = question) => {
    const trimmedQuestion = nextQuestion.trim();

    if (!trimmedQuestion || isAsking) return;

    setQuestion("");
    setIsAsking(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", content: trimmedQuestion },
    ]);

    try {
      const answer = await onAskRepository(repository.id, trimmedQuestion);

      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          role: "assistant",
          content:
            err.message || "I could not answer that yet. Try another question.",
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <section className="mt-6 flex min-h-[360px] flex-col rounded-[calc(var(--radius)+1rem)] border border-border bg-card p-3 shadow-sm">
      <div className="px-2 pb-3 pt-1 text-center">
        <h2 className="text-xl font-semibold tracking-[-0.055em] text-foreground">
          Ready when you are.
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask onboarding questions about {repository.name}.
        </p>
      </div>

      <div
        ref={messagesRef}
        className="flex max-h-[260px] flex-1 flex-col gap-3 overflow-y-auto px-1 py-2"
      >
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={
              message.role === "user"
                ? "ml-auto max-w-[78%] rounded-[calc(var(--radius)+0.75rem)] bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground"
                : "mr-auto max-w-[82%] rounded-[calc(var(--radius)+0.75rem)] border border-border bg-background px-4 py-3 text-sm leading-relaxed text-foreground"
            }
          >
            <div className="whitespace-pre-wrap">{message.content}</div>
          </div>
        ))}
        {isAsking && (
          <div className="mr-auto rounded-[calc(var(--radius)+0.75rem)] border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
            Thinking...
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {onboardingPrompts.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            className="rounded-full"
            disabled={isAsking}
            onClick={() => askQuestion(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>

      <div className="mt-3 flex h-14 items-center rounded-full border border-border bg-background px-2 shadow-sm transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Add context"
        >
          <Plus />
        </Button>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") askQuestion();
          }}
          placeholder="Ask anything about this codebase"
          className="h-full min-w-0 flex-1 border-none bg-transparent px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          disabled={isAsking}
        />
        <Button
          type="button"
          variant="default"
          size="icon"
          className="rounded-full"
          disabled={isAsking || !question.trim()}
          onClick={() => askQuestion()}
          aria-label="Send question"
        >
          <ArrowUp />
        </Button>
      </div>
    </section>
  );
}

function Home({
  repositories,
  selectedRepository,
  selectedDetails,
  onAskRepository,
}) {
  const navigate = useNavigate();

  if (repositories.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            No repositories yet
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add a GitHub repository to clone it locally and start exploring its
            files.
          </p>
          <Button className="mt-6 rounded-full" onClick={() => navigate("/")}>
            Add repository
          </Button>
        </div>
      </div>
    );
  }

  const repository = selectedRepository || repositories[0];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Current repository
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
          {repository.name}
        </h1>
        <p className="mt-2 max-w-2xl truncate text-sm text-muted-foreground">
          {repository.url}
        </p>

        <div className="mt-6 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold tabular-nums">
                {selectedDetails?.fileCount ?? "-"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Files</div>
            </div>
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold tabular-nums">
                {selectedDetails?.directoryCount ?? "-"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Folders</div>
            </div>
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold">
                {formatDate(repository.addedAt)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Indexed</div>
            </div>
          </div>

          <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-foreground">
                  Local clone
                </h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {repository.localPath}
                </p>
              </div>
              <Button
                className="rounded-full"
                onClick={() => navigate("/explorer")}
              >
                Open explorer
              </Button>
            </div>
          </div>
        </div>

        <RepositoryChat
          repository={repository}
          onAskRepository={onAskRepository}
        />
      </div>
    </div>
  );
}

function FileTree({ items, depth = 0 }) {
  if (!items?.length) return null;

  return (
    <div
      className={
        depth === 0 ? "flex flex-col gap-1" : "mt-1 flex flex-col gap-1"
      }
    >
      {items.map((item) => (
        <div key={`${depth}-${item.name}`}>
          <div
            className="rounded-lg px-2 py-1.5 text-sm text-muted-foreground"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <span className="text-foreground">{item.name}</span>
            <span className="ml-2 text-[11px] uppercase tracking-wide">
              {item.type}
            </span>
          </div>
          {item.children?.length > 0 && (
            <FileTree items={item.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

function Explorer({ selectedRepository, selectedDetails, isInspecting }) {
  const navigate = useNavigate();

  if (!selectedRepository) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            Choose a repository
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add or select a repository to browse its files.
          </p>
          <Button className="mt-6 rounded-full" onClick={() => navigate("/")}>
            Add repository
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Explorer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
          {selectedRepository.name}
        </h1>
        <div className="mt-6 rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-3 shadow-sm">
          {isInspecting ? (
            <div className="p-3 text-sm text-muted-foreground">
              Reading repository files...
            </div>
          ) : (
            <FileTree items={selectedDetails?.tree ?? []} />
          )}
        </div>
      </div>
    </div>
  );
}

function Onboarding({ onAddRepository }) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [isIndexing, setIsIndexing] = useState(false);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const logContainerRef = useRef(null);

  const handleIndex = async () => {
    if (!url.trim()) return;

    setError("");
    setIsIndexing(true);
    setLogs([`Connecting to repository: ${url.trim()}`]);

    try {
      setLogs((prev) => [...prev, "Cloning the default branch locally..."]);
      const repository = await onAddRepository(url.trim());
      setLogs((prev) => [
        ...prev,
        `Indexed ${repository.fileCount} files in ${repository.directoryCount} folders.`,
        "Opening repository dashboard...",
      ]);
      navigate("/home");
    } catch (err) {
      setError(err.message || "Could not add this repository.");
      setLogs((prev) => [
        ...prev,
        "Indexing failed. Check the URL and try again.",
      ]);
    } finally {
      setIsIndexing(false);
    }
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center">
        <div className="mb-8 text-center">
          <h2 className="mb-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
            Index a repository
          </h2>
          <p className="text-sm text-muted-foreground">
            Paste a GitHub URL to get started
          </p>
        </div>

        {/* URL Input Area */}
        <div className="w-full">
          <div className="relative flex h-14 items-center rounded-full border border-border bg-card px-2 shadow-sm transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <Button
              variant="ghost"
              size="icon"
              className="flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-5 w-5" />
            </Button>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo"
              className="h-full flex-1 border-none bg-transparent px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleIndex();
              }}
            />
            <div className="flex flex-shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <LinkIcon className="h-5 w-5" />
              </Button>
              <Button
                variant="default"
                size="icon"
                className="rounded-full"
                onClick={handleIndex}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Suggestion Chips */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <Globe className="h-4 w-4" />
              <span>Try a public repo</span>
            </button>
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <BookOpen className="h-4 w-4" />
              <span>Browse examples</span>
            </button>
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <Info className="h-4 w-4" />
              <span>Learn more</span>
            </button>
          </div>

          {/* Progress Log */}
          {isIndexing && (
            <div
              ref={logContainerRef}
              className="mt-4 h-40 overflow-y-auto rounded-[calc(var(--radius)+0.5rem)] border border-border bg-card p-4 shadow-sm"
            >
              {logs.map((log, index) => (
                <div
                  key={index}
                  className="mb-1.5 flex animate-in items-start gap-2 text-sm text-muted-foreground fade-in-0 slide-in-from-bottom-1 duration-200"
                  style={{ animationDelay: `${Math.min(index * 40, 160)}ms` }}
                >
                  <span className="leading-snug text-foreground">•</span>
                  <span className="leading-snug">{log}</span>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-[calc(var(--radius)+0.5rem)] border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Layout({
  children,
  repositories,
  selectedRepositoryId,
  onSelectRepository,
}) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background font-sans text-foreground antialiased selection:bg-accent selection:text-foreground">
      {/* Custom Titlebar Drag Region */}
      <div
        className="absolute top-0 left-0 w-full h-8 z-50 pointer-events-none"
        style={{ WebkitAppRegion: "drag" }}
      />

      <Sidebar
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
        onSelectRepository={onSelectRepository}
      />
      <main className="flex-1 flex flex-col bg-background h-full overflow-hidden relative">
        {/* Page Content */}
        {children}
      </main>
    </div>
  );
}

export default function App() {
  const [repositories, setRepositories] = useState([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const repositoryApi = useMemo(getRepositoryApi, []);

  useEffect(() => {
    async function loadRepositories() {
      if (!repositoryApi) return;

      const storedRepositories = await repositoryApi.list();
      setRepositories(storedRepositories);

      if (storedRepositories.length > 0) {
        setSelectedRepositoryId(
          (currentId) => currentId || storedRepositories[0].id,
        );
      }
    }

    loadRepositories();
  }, [repositoryApi]);

  useEffect(() => {
    async function inspectSelectedRepository() {
      if (!repositoryApi || !selectedRepositoryId) {
        setSelectedDetails(null);
        return;
      }

      setIsInspecting(true);

      try {
        setSelectedDetails(await repositoryApi.inspect(selectedRepositoryId));
      } finally {
        setIsInspecting(false);
      }
    }

    inspectSelectedRepository();
  }, [repositoryApi, selectedRepositoryId]);

  const selectedRepository =
    repositories.find((repository) => repository.id === selectedRepositoryId) ||
    null;

  const handleAddRepository = async (repositoryUrl) => {
    if (!repositoryApi) {
      throw new Error(
        "Repository indexing is only available in the Electron app.",
      );
    }

    const repository = await repositoryApi.add(repositoryUrl);
    setRepositories((currentRepositories) => [
      repository,
      ...currentRepositories.filter((item) => item.id !== repository.id),
    ]);
    setSelectedRepositoryId(repository.id);
    setSelectedDetails(repository);

    return repository;
  };

  const handleAskRepository = async (repositoryId, question) => {
    if (!repositoryApi) {
      throw new Error("Repository Q&A is only available in the Electron app.");
    }

    return repositoryApi.ask(repositoryId, question);
  };

  return (
    <TooltipProvider>
      <Router>
        <Layout
          repositories={repositories}
          selectedRepositoryId={selectedRepositoryId}
          onSelectRepository={setSelectedRepositoryId}
        >
          <Routes>
            <Route
              path="/"
              element={<Onboarding onAddRepository={handleAddRepository} />}
            />
            <Route
              path="/home"
              element={
                <Home
                  repositories={repositories}
                  selectedRepository={selectedRepository}
                  selectedDetails={selectedDetails}
                  onAskRepository={handleAskRepository}
                />
              }
            />
            <Route
              path="/explorer"
              element={
                <Explorer
                  selectedRepository={selectedRepository}
                  selectedDetails={selectedDetails}
                  isInspecting={isInspecting}
                />
              }
            />
          </Routes>
        </Layout>
      </Router>
    </TooltipProvider>
  );
}
