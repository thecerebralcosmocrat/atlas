import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

function getGraphApi() {
  return window.electronAPI?.graph;
}

function summarizeGraph(nodes, edges) {
  const fileNodes = [];
  const nodeById = new Map();
  const symbolsByFile = new Map();
  const importsByFile = new Map();
  let externalCount = 0;

  for (const node of nodes) {
    nodeById.set(node.id, node);

    if (node.type === "file") {
      fileNodes.push(node);
    } else if (node.type === "external") {
      externalCount += 1;
    } else {
      const key = `file:${node.fileId}`;
      const symbols = symbolsByFile.get(key) ?? [];

      symbols.push(node);
      symbolsByFile.set(key, symbols);
    }
  }

  for (const edge of edges) {
    if (edge.type !== "imports") continue;

    for (const [key, side] of [
      [edge.source, "outbound"],
      [edge.target, "inbound"],
    ]) {
      const entry = importsByFile.get(key) ?? { outbound: [], inbound: [] };

      entry[side].push(edge);
      importsByFile.set(key, entry);
    }
  }

  return { fileNodes, nodeById, symbolsByFile, importsByFile, externalCount };
}

function ImportList({ edges, nodeById, direction }) {
  if (edges.length === 0) {
    return <div className="mt-1 text-muted-foreground">None</div>;
  }

  return (
    <ul className="mt-1 flex flex-col gap-1">
      {edges.map((edge, index) => {
        const otherId = direction === "outbound" ? edge.target : edge.source;
        const other = nodeById.get(otherId);
        const label =
          other?.label ??
          edge.specifier ??
          (direction === "outbound" ? edge.target : edge.source);

        return (
          <li
            key={`${edge.specifier ?? "edge"}-${index}`}
            className="flex items-center gap-2"
          >
            <span className="truncate text-foreground" title={label}>
              {label}
            </span>
            {edge.importType && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                {edge.importType}
              </span>
            )}
            {edge.external && (
              <span className="shrink-0 bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                external
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function CodeGraphPanel({ repository }) {
  const graphApi = useMemo(getGraphApi, []);
  const [graph, setGraph] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    setGraph(null);
    setError("");
    setExpandedId(null);

    if (!graphApi || !repository?.id) return undefined;

    setIsLoading(true);
    graphApi
      .get(repository.id)
      .then((result) => {
        if (!cancelled) setGraph(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Could not load the code graph.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [graphApi, repository?.id]);

  const { fileNodes, nodeById, symbolsByFile, importsByFile, externalCount } =
    useMemo(
      () => summarizeGraph(graph?.nodes ?? [], graph?.edges ?? []),
      [graph],
    );

  const symbolCount = fileNodes.reduce(
    (total, file) => total + (symbolsByFile.get(file.id)?.length ?? 0),
    0,
  );

  return (
    <section className="border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Code graph</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {fileNodes.length} files · {symbolCount} symbols · {externalCount}{" "}
          external packages
        </p>
      </div>

      {isLoading && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Building graph...
        </div>
      )}

      {error && (
        <div className="px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!isLoading && !error && fileNodes.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          No symbols or imports were found. Re-index this repository to build
          the graph.
        </div>
      )}

      {!isLoading && !error && fileNodes.length > 0 && (
        <div className="divide-y divide-border">
          {fileNodes.map((file) => {
            const isOpen = expandedId === file.id;
            const symbols = symbolsByFile.get(file.id) ?? [];
            const { outbound = [], inbound = [] } =
              importsByFile.get(file.id) ?? {};
            const Chevron = isOpen ? ChevronDown : ChevronRight;

            return (
              <div
                key={file.id}
                className="transition-colors duration-150 ease-out hover:bg-muted/40"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpandedId(isOpen ? null : file.id)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Chevron className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-foreground" title={file.path}>
                    {file.path}
                  </span>
                  <span className="ms-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {symbols.length} sym · {outbound.length} out ·{" "}
                    {inbound.length} in
                  </span>
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-3 px-4 pb-3 ps-10 text-xs">
                    <div>
                      <div className="font-medium text-muted-foreground">
                        Symbols
                      </div>
                      {symbols.length === 0 ? (
                        <div className="mt-1 text-muted-foreground">None</div>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-1">
                          {symbols.map((symbol) => (
                            <li
                              key={symbol.id}
                              className="flex items-center gap-2"
                            >
                              <span className="shrink-0 bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {symbol.type}
                              </span>
                              <span
                                className="truncate text-foreground"
                                title={symbol.label}
                              >
                                {symbol.label}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                L{symbol.lineStart}–{symbol.lineEnd}
                              </span>
                              {symbol.isExported && (
                                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  exported
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <div className="font-medium text-muted-foreground">
                        Imports
                      </div>
                      <ImportList
                        edges={outbound}
                        nodeById={nodeById}
                        direction="outbound"
                      />
                    </div>

                    <div>
                      <div className="font-medium text-muted-foreground">
                        Imported by
                      </div>
                      <ImportList
                        edges={inbound}
                        nodeById={nodeById}
                        direction="inbound"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
