import { useEffect, useMemo, useState } from "react";

function getImpactApi() {
  return window.electronAPI?.graph?.impact;
}

export default function ImpactPanel({ repository }) {
  const impactApi = useMemo(getImpactApi, []);
  const [data, setData] = useState(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!impactApi || !repository?.id) return undefined;

    setIsLoading(true);
    setError("");
    impactApi(repository.id, selectedPath || undefined)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Could not analyze this repository.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [impactApi, repository?.id, selectedPath]);

  const files = data?.files ?? [];
  const unreachable = data?.unreachable ?? [];
  const impact = data?.impact ?? null;

  return (
    <section className="border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Impact</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {files.length} indexed {files.length === 1 ? "file" : "files"} ·{" "}
          {unreachable.length} not reachable from an entry point
        </p>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!error && !isLoading && files.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          No indexed files to analyze. Re-index this repository.
        </div>
      )}

      {files.length > 0 && (
        <div className="px-4 py-3">
          <label
            htmlFor="impact-target"
            className="text-xs font-medium text-muted-foreground"
          >
            What does changing a file affect?
          </label>
          <select
            id="impact-target"
            value={selectedPath}
            onChange={(event) => setSelectedPath(event.target.value)}
            className="mt-1 w-full rounded-none border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Choose a file...</option>
            {files.map((file) => (
              <option key={file.id ?? file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </div>
      )}

      {!error && impact && (
        <div className="flex flex-col gap-3 px-4 py-3 text-xs">
          <div>
            <div className="font-medium text-muted-foreground">
              Imported directly by ({impact.importers.length})
            </div>
            {impact.importers.length === 0 ? (
              <div className="mt-1 text-muted-foreground">
                Nothing in the index imports this file.
              </div>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {impact.importers.map((importer) => (
                  <li
                    key={importer.path}
                    className="flex items-center gap-2"
                  >
                    <span
                      className="truncate text-foreground"
                      title={importer.path}
                    >
                      {importer.path}
                    </span>
                    <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {importer.importType}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="font-medium text-muted-foreground">
              Blast radius ({impact.dependents.length})
            </div>
            {impact.dependents.length === 0 ? (
              <div className="mt-1 text-muted-foreground">
                No other indexed file depends on it.
              </div>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {impact.dependents.slice(0, 20).map((dependent) => (
                  <li key={dependent.path} className="flex items-center gap-2">
                    <span
                      className="truncate text-foreground"
                      title={dependent.path}
                    >
                      {dependent.path}
                    </span>
                    <span className="ms-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {dependent.distance} hop
                      {dependent.distance === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {!error && !isLoading && unreachable.length > 0 && (
        <div className="px-4 py-3 text-xs">
          <div className="font-medium text-muted-foreground">
            Not reachable from an entry point ({unreachable.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {unreachable.slice(0, 12).map((filePath) => (
              <li
                key={filePath}
                className="truncate text-foreground"
                title={filePath}
              >
                {filePath}
              </li>
            ))}
          </ul>
          {unreachable.length > 12 && (
            <div className="mt-1 text-muted-foreground">
              ...and {unreachable.length - 12} more
            </div>
          )}
        </div>
      )}

      {!error && !isLoading && data && !data.hasEntryPoints && (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          No entry points were found, so reachability cannot be judged yet.
        </div>
      )}
    </section>
  );
}
