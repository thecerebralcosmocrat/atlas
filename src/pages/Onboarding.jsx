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
      setIsIndexing(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (!window.electronAPI?.repositories?.onIndexProgress) return undefined;

    const unsubscribe = window.electronAPI.repositories.onIndexProgress(
      (data) => {
        setProgress(data);
      },
    );

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
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

          {progress && (
            <div className="mt-4 border border-border p-4">
              <div className="flex justify-between items-center mb-2 text-sm text-muted-foreground">
                <span className="truncate">
                  {progress.currentFile
                    ? progress.currentFile.length > 40
                      ? progress.currentFile.slice(-40)
                      : progress.currentFile
                    : "Preparing…"}
                </span>
                <span className="font-medium shrink-0 ms-4">
                  {progress.completed} / {progress.total} files
                </span>
              </div>
              <div className="w-full bg-secondary h-2 rounded-none overflow-hidden">
                <div
                  className="bg-primary h-full rounded-none transition-all duration-300 ease-out"
                  style={{
                    width: `${
                      progress.total > 0
                        ? (progress.completed / progress.total) * 100
                        : 0
                    }%`,
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
