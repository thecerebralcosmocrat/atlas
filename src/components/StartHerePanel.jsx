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

function getStartHereApi() {
  return window.electronAPI?.graph?.startHere;
}

function RowsSkeleton() {
  return (
    <ItemGroup variant="plain" aria-label="Loading entry points">
      {[0, 1, 2].map((row) => (
        <Item key={row}>
          <ItemContent>
            <Skeleton className="h-4 w-1/2" />
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
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
    <Card>
      <CardHeader>
        <CardTitle>Start here</CardTitle>
        <CardDescription>
          {entryCount} entry {entryCount === 1 ? "point" : "points"} ·{" "}
          {readingPath.length} {readingPath.length === 1 ? "file" : "files"} to
          read
        </CardDescription>
      </CardHeader>

      <CardContent flush>
        <SkeletonSwap
          loading={isLoading}
          fallback={<RowsSkeleton />}
          label="Finding entry points"
        >
          {error && (
            <Empty reason="error" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>{error}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!error && readingPath.length === 0 && (
            <Empty reason="empty" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>
                  No entry points or imports were found. Re-index this
                  repository to build the reading path.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!error && readingPath.length > 0 && (
            <ItemGroup variant="plain" aria-label="Reading path">
              {readingPath.map((item, index) => (
                <Item key={item.path}>
                  <span className="w-5 shrink-0 type-caption text-text-2 tabular-nums">
                    {index + 1}
                  </span>
                  <ItemContent>
                    <ItemTitle>
                      <Truncate position="middle" className="mono">
                        {item.path}
                      </Truncate>
                    </ItemTitle>
                  </ItemContent>
                  {item.isEntry ? (
                    <Badge>{item.reason}</Badge>
                  ) : (
                    <ItemMeta>
                      {item.fanIn} importer{item.fanIn === 1 ? "" : "s"}
                    </ItemMeta>
                  )}
                </Item>
              ))}
            </ItemGroup>
          )}
        </SkeletonSwap>
      </CardContent>
    </Card>
  );
}
