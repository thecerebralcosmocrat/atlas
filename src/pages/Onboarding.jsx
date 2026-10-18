import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Onboarding({ onAddRepository }) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [isIndexing, setIsIndexing] = useState(false);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const logContainerRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const [addProgress, setAddProgress] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // State updates land after the event that started the add, so two Enter
  // presses in the same tick would both see `isIndexing === false` and start
  // two clones. The ref closes that window.
  const submitInFlightRef = useRef(false);

  const handleIndex = async () => {
    if (submitInFlightRef.current || !url.trim()) return;

    submitInFlightRef.current = true;
    setError("");
    setIsIndexing(true);
    setAddProgress(null);
    setProgress(null);
    setLogs([`Connecting to repository: ${url.trim()}`]);

    try {
      setLogs((prev) => [...prev, "Cloning the default branch locally..."]);
      const repository = await onAddRepository(url.trim());
      setLogs((prev) => [
        ...prev,
        `Indexed ${repository.fileCount} files in ${repository.directoryCount} folders.`,
        "Opening repository...",
      ]);
      navigate("/repo?tab=overview");
    } catch (err) {
      setError(err.message || "Could not add this repository.");
      setLogs((prev) => [
        ...prev,
        "Indexing failed. Check the URL and try again.",
      ]);
    } finally {
      submitInFlightRef.current = false;
      setIsIndexing(false);
      setProgress(null);
      setAddProgress(null);
    }
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // A clone of a large repository can take over a minute. The seconds counter
  // is the difference between "working" and an app that looks frozen.
  useEffect(() => {
    if (!isIndexing) {
      setElapsedSeconds(0);
      return undefined;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [isIndexing]);

  useEffect(() => {
    const repositories = window.electronAPI?.repositories;

    if (!repositories?.onIndexProgress) return undefined;

    const unsubscribeProgress = repositories.onIndexProgress((data) => {
      // Index ticks resume after embedding, so they also clear the embedding
      // phase; leaving it set would hide the final file count.
      setAddProgress(null);
      setProgress(data);
    });
    const unsubscribeAdd =
      repositories.onAddProgress?.((data) => setAddProgress(data)) ?? (() => {});

    return () => {
      unsubscribeProgress();
      unsubscribeAdd();
    };
  }, []);

  const phase = addProgress?.phase ?? null;
  const isCloning = isIndexing && phase === "clone";
  const isEmbedding = isIndexing && phase === "embedding";
  const showProgress = isIndexing && (isCloning || isEmbedding || phase === "index" || progress);
  const clonePercent =
    isCloning && typeof addProgress.percent === "number"
      ? addProgress.percent
      : null;
  let progressLabel = "Preparing…";
  let progressDetail = `${elapsedSeconds}s`;
  let progressPercent = null;

  if (isCloning) {
    progressLabel = addProgress.stage
      ? `Cloning · ${addProgress.stage} objects`
      : "Cloning the default branch";
    progressPercent = clonePercent;
    progressDetail =
      clonePercent === null ? `${elapsedSeconds}s` : `${clonePercent}%`;
  } else if (isEmbedding) {
    progressLabel = "Building the semantic search index";
    progressDetail = `${elapsedSeconds}s`;
  } else if (progress) {
    progressLabel = progress.currentFile
      ? progress.currentFile.length > 40
        ? progress.currentFile.slice(-40)
        : progress.currentFile
      : "Preparing…";
    progressPercent =
      progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
    progressDetail = `${progress.completed} / ${progress.total} files`;
  } else if (isIndexing) {
    progressLabel = "Reading files";
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-10">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
            Index a repository
          </h1>
          <p className="text-sm text-muted-foreground">
            Paste a GitHub URL to get started
          </p>
        </div>

        <div className="w-full">
          <label htmlFor="repo-url" className="sr-only">
            Repository URL
          </label>
          <div className="relative flex h-14 items-center rounded-none border border-border bg-background px-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <input
              id="repo-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isIndexing}
              placeholder="https://github.com/user/repo"
              className="h-full flex-1 border-none bg-transparent px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleIndex();
              }}
              autoFocus
            />
            <Button
              type="button"
              variant="default"
              size="icon"
              className="rounded-none"
              onClick={handleIndex}
              disabled={isIndexing || !url.trim()}
              aria-label="Index repository"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </div>

          {isIndexing && (
            <div
              ref={logContainerRef}
              className="mt-4 h-40 overflow-y-auto border border-border p-4"
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

          {showProgress && (
            <div className="mt-4 border border-border p-4">
              <div className="flex justify-between items-center mb-2 text-sm text-muted-foreground">
                <span className="truncate">{progressLabel}</span>
                <span className="font-medium shrink-0 ms-4 tabular-nums">
                  {progressDetail}
                </span>
              </div>
              <div className="w-full bg-secondary h-2 rounded-none overflow-hidden">
                <div
                  className={
                    progressPercent === null
                      ? "bg-primary h-full rounded-none animate-pulse"
                      : "bg-primary h-full rounded-none transition-all duration-300 ease-out"
                  }
                  style={{
                    width:
                      progressPercent === null
                        ? "100%"
                        : `${Math.min(100, Math.max(0, progressPercent))}%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
