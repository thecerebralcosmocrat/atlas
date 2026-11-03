import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/glaze/ui/card";
import { Badge } from "@/components/glaze/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleGroup,
  CollapsibleTrigger,
} from "@/components/glaze/ui/collapsible";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@/components/glaze/ui/empty-state";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMeta,
  ItemTitle,
} from "@/components/glaze/ui/item";
import { Skeleton, SkeletonSwap } from "@/components/glaze/ui/skeleton";
import { Truncate } from "@/components/glaze/ui/truncate";

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

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 py-3" aria-hidden>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-4 w-1/2" />
      ))}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="flex flex-col gap-1 pt-2">
      <h4 className="type-label text-text-2">{title}</h4>
      {children}
    </div>
  );
}

function ImportList({ edges, nodeById, direction, label }) {
  if (edges.length === 0) {
    return <p className="type-body-sm text-text-2">None</p>;
  }

  return (
    <ItemGroup variant="plain" aria-label={label}>
      {edges.map((edge, index) => {
        const otherId = direction === "outbound" ? edge.target : edge.source;
        const other = nodeById.get(otherId);
        const text =
          other?.label ??
          edge.specifier ??
          (direction === "outbound" ? edge.target : edge.source);

        return (
          <Item key={`${edge.specifier ?? "edge"}-${index}`} size="sm">
            <ItemContent>
              <ItemTitle>
                <Truncate position="middle" className="mono">
                  {text}
                </Truncate>
              </ItemTitle>
            </ItemContent>
            {edge.importType && <Badge>{edge.importType}</Badge>}
            {edge.external && <Badge variant="outline">external</Badge>}
          </Item>
        );
      })}
    </ItemGroup>
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
    <Card>
      <CardHeader>
        <CardTitle>Code graph</CardTitle>
        <CardDescription>
          {fileNodes.length} files · {symbolCount} symbols · {externalCount}{" "}
          external packages
        </CardDescription>
      </CardHeader>

      <CardContent flush>
        <SkeletonSwap
          loading={isLoading}
          fallback={<RowsSkeleton />}
          label="Building graph"
        >
          {error && (
            <Empty reason="error" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>{error}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!isLoading && !error && fileNodes.length === 0 && (
            <Empty reason="empty" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>
                  No symbols or imports were found. Re-index this repository to
                  build the graph.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!isLoading && !error && fileNodes.length > 0 && (
            <div className="px-3">
              <CollapsibleGroup
                variant="plain"
                value={expandedId == null ? [] : [expandedId]}
                onValueChange={(value) => setExpandedId(value[0] ?? null)}
              >
                {fileNodes.map((file) => {
                  const symbols = symbolsByFile.get(file.id) ?? [];
                  const { outbound = [], inbound = [] } =
                    importsByFile.get(file.id) ?? {};

                  return (
                    <Collapsible key={file.id} value={file.id}>
                      <CollapsibleTrigger>
                        <span className="flex w-full min-w-0 items-baseline gap-2">
                          <span className="min-w-0 flex-1">
                            <Truncate position="middle" className="mono">
                              {file.path}
                            </Truncate>
                          </span>
                          <span className="shrink-0 type-caption text-text-2">
                            {symbols.length} sym · {outbound.length} out ·{" "}
                            {inbound.length} in
                          </span>
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="flex flex-col gap-3">
                          <Section title="Symbols">
                            {symbols.length === 0 ? (
                              <p className="type-body-sm text-text-2">None</p>
                            ) : (
                              <ItemGroup variant="plain" aria-label="Symbols">
                                {symbols.map((symbol) => (
                                  <Item key={symbol.id} size="sm">
                                    <Badge>{symbol.type}</Badge>
                                    <ItemContent>
                                      <ItemTitle>
                                        <Truncate className="mono">
                                          {symbol.label}
                                        </Truncate>
                                      </ItemTitle>
                                    </ItemContent>
                                    <ItemMeta>
                                      L{symbol.lineStart}–{symbol.lineEnd}
                                    </ItemMeta>
                                    {symbol.isExported && (
                                      <Badge variant="outline">exported</Badge>
                                    )}
                                  </Item>
                                ))}
                              </ItemGroup>
                            )}
                          </Section>

                          <Section title="Imports">
                            <ImportList
                              edges={outbound}
                              nodeById={nodeById}
                              direction="outbound"
                              label="Imports"
                            />
                          </Section>

                          <Section title="Imported by">
                            <ImportList
                              edges={inbound}
                              nodeById={nodeById}
                              direction="inbound"
                              label="Imported by"
                            />
                          </Section>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </CollapsibleGroup>
            </div>
          )}
        </SkeletonSwap>
      </CardContent>
    </Card>
  );
}
