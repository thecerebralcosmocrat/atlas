import { useEffect, useMemo, useState } from "react";

function getStartHereApi() {
  return window.electronAPI?.graph?.startHere;
}

export default function StartHerePanel({ repository }) {
  const startHereApi = useMemo(getStartHereApi, []);
  const [startHere, setStartHere] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    setStartHere(null);
    setError("");

    if (!startHereApi || !repository?.id) return undefined;

    setIsLoading(true);
    startHereApi(repository.id)
      .then((result) => {
        if (!cancelled) setStartHere(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Could not work out where to start.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [startHereApi, repository?.id]);

  const readingPath = startHere?.readingPath ?? [];
  const entryCount = startHere?.entries?.length ?? 0;

  return (
    <section className="border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Start here</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {entryCount} entry {entryCount === 1 ? "point" : "points"} ·{" "}
          {readingPath.length} {readingPath.length === 1 ? "file" : "files"}{" "}
          to read
        </p>
      </div>

      {isLoading && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Finding entry points...
        </div>
      )}

      {error && (
        <div className="px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!isLoading && !error && readingPath.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          No entry points or imports were found. Re-index this repository to
          build the reading path.
        </div>
      )}

      {!isLoading && !error && readingPath.length > 0 && (
        <ol className="divide-y divide-border">
          {readingPath.map((item, index) => (
            <li
              key={item.path}
              className="flex items-center gap-2 px-4 py-2 text-sm"
            >
              <span className="flex size-5 shrink-0 items-center justify-center bg-muted text-[11px] text-muted-foreground">
                {index + 1}
              </span>
              <span className="truncate text-foreground" title={item.path}>
                {item.path}
              </span>
              {item.isEntry ? (
                <span className="ms-auto shrink-0 bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.reason}
                </span>
              ) : (
                <span className="ms-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {item.fanIn} importer{item.fanIn === 1 ? "" : "s"}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
