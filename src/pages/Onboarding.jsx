import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, ArrowUp } from "@/components/glaze/icon";
import { Alert, AlertTitle, AlertDescription } from "@/components/glaze/ui/alert";
import { Input, InputAction } from "@/components/glaze/ui/input";
import { LogViewer } from "@/components/glaze/ui/log-viewer";
import { Progress, ProgressLabel, ProgressValue } from "@/components/glaze/ui/progress";

export default function Onboarding({ onAddRepository }) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [isIndexing, setIsIndexing] = useState(false);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
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
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center">
        <div className="mb-8 text-center">
          <h1 className="type-title mb-2 text-text-1">Index a repository</h1>
          <p className="type-body text-text-2">
            Paste a GitHub URL to get started
          </p>
        </div>

        <div className="flex w-full flex-col gap-4">
          <Input
            id="repo-url"
            size="lg"
            aria-label="Repository URL"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isIndexing}
            placeholder="https://github.com/user/repo"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleIndex();
            }}
            autoFocus
            trailing={
              <InputAction
                variant="primary"
                aria-label="Index repository"
                onClick={handleIndex}
                disabled={isIndexing || !url.trim()}
              >
                <Icon icon={ArrowUp} />
              </InputAction>
            }
          />

          {isIndexing && (
            <LogViewer
              label="Indexing log"
              lines={logs.map((message, index) => ({
                id: index,
                level: "info",
                message,
              }))}
              streaming={isIndexing}
              timestamps={false}
              height={160}
            />
          )}

          {showProgress && (
            <Progress
              value={
                progressPercent === null
                  ? null
                  : Math.min(100, Math.max(0, progressPercent))
              }
            >
              <ProgressLabel>{progressLabel}</ProgressLabel>
              <ProgressValue>{() => progressDetail}</ProgressValue>
            </Progress>
          )}

          {error && (
            <Alert status="fail">
              <AlertTitle>Could not add this repository</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}
