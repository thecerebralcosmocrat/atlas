import { useEffect, useMemo, useState } from "react";

function getOwnershipApi() {
  return window.electronAPI?.graph?.ownership;
}

export default function OwnershipPanel({ repository }) {
  const ownershipApi = useMemo(getOwnershipApi, []);
  const [data, setData] = useState(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!ownershipApi || !repository?.id) return undefined;

    setIsLoading(true);
    setError("");
    ownershipApi(repository.id, selectedPath || undefined)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Could not read this repository's history.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ownershipApi, repository?.id, selectedPath]);

  const files = data?.files ?? [];
  const contributors = data?.contributors ?? [];
  const hotspots = data?.hotspots ?? [];
  const recent = data?.recent ?? [];
  const file = data?.file ?? null;
  const commitCount = data?.commitCount ?? 0;

  return (
    <section className="border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Ownership</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {files.length} indexed {files.length === 1 ? "file" : "files"} ·{" "}
          {commitCount} {commitCount === 1 ? "commit" : "commits"}
          {data?.shallow ? " (limited history)" : ""}
        </p>
      </div>

      {isLoading && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Reading git history...
        </div>
      )}

      {error && (
        <div className="px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!error && !isLoading && data && commitCount === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          No git history is available for this clone, so ownership cannot be
          worked out. Re-add the repository to fetch its history.
        </div>
      )}

      {!error && commitCount > 0 && files.length > 0 && (
        <div className="px-4 py-3">
          <label
            htmlFor="ownership-target"
            className="text-xs font-medium text-muted-foreground"
          >
            Who should I ask about a file?
          </label>
          <select
            id="ownership-target"
            value={selectedPath}
            onChange={(event) => setSelectedPath(event.target.value)}
            className="mt-1 w-full rounded-none border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Choose a file...</option>
            {files.map((entry) => (
              <option key={entry.id ?? entry.path} value={entry.path}>
                {entry.path}
              </option>
            ))}
          </select>
        </div>
      )}

      {!error && file && (
        <div className="flex flex-col gap-2 px-4 py-3 text-xs">
          <div className="font-medium text-muted-foreground">
            {file.commitCount === 0
              ? "No commits touch this file."
              : `Changed in ${file.commitCount} ${
                  file.commitCount === 1 ? "commit" : "commits"
                }`}
          </div>
          <ul className="flex flex-col gap-1">
            {file.authors.map((author) => (
              <li
                key={author.email || author.name}
                className="flex items-center gap-2"
              >
                <span className="truncate text-foreground">{author.name}</span>
                <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {author.count} {author.count === 1 ? "commit" : "commits"} ·{" "}
                  {String(author.lastChangedAt ?? "").slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!error && !isLoading && hotspots.length > 0 && (
        <div className="px-4 py-3 text-xs">
          <div className="font-medium text-muted-foreground">
            Churn hotspots ({hotspots.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {hotspots.map((hotspot) => (
              <li key={hotspot.path} className="flex items-center gap-2">
                <span className="truncate text-foreground" title={hotspot.path}>
                  {hotspot.path}
                </span>
                <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {hotspot.commitCount}{" "}
                  {hotspot.commitCount === 1 ? "commit" : "commits"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!error && !isLoading && recent.length > 0 && (
        <div className="px-4 py-3 text-xs">
          <div className="font-medium text-muted-foreground">
            Recently changed ({recent.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {recent.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2">
                <span className="truncate text-foreground" title={entry.path}>
                  {entry.path}
                </span>
                <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {String(entry.lastChangedAt ?? "").slice(0, 10)}
                  {entry.lastAuthor?.name ? ` · ${entry.lastAuthor.name}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!error && !isLoading && contributors.length > 0 && (
        <div className="px-4 py-3 text-xs">
          <div className="font-medium text-muted-foreground">
            Who has touched this most ({contributors.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {contributors.slice(0, 8).map((contributor) => (
              <li
                key={contributor.email || contributor.name}
                className="flex items-center gap-2"
              >
                <span className="truncate text-foreground">
                  {contributor.name}
                </span>
                <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {contributor.commitCount}{" "}
                  {contributor.commitCount === 1 ? "commit" : "commits"} ·{" "}
                  {contributor.fileCount}{" "}
                  {contributor.fileCount === 1 ? "file" : "files"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
