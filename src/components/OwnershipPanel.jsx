import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/glaze/ui/card";
import { ComboboxField } from "@/components/glaze/ui/combobox";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@/components/glaze/ui/empty-state";
import { Field, FieldLabel } from "@/components/glaze/ui/field";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMeta,
  ItemTitle,
} from "@/components/glaze/ui/item";
import { Skeleton, SkeletonSwap } from "@/components/glaze/ui/skeleton";
import { Truncate } from "@/components/glaze/ui/truncate";

function getOwnershipApi() {
  return window.electronAPI?.graph?.ownership;
}

function RowsSkeleton() {
  return (
    <ItemGroup variant="plain" aria-label="Loading">
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

function PathRow({ path, meta }) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          <Truncate position="middle" className="mono">
            {path}
          </Truncate>
        </ItemTitle>
      </ItemContent>
      <ItemMeta>{meta}</ItemMeta>
    </Item>
  );
}

function PersonRow({ name, meta }) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          <Truncate>{name}</Truncate>
        </ItemTitle>
      </ItemContent>
      <ItemMeta>{meta}</ItemMeta>
    </Item>
  );
}

function Section({ title, children }) {
  return (
    <div className="flex flex-col gap-1 py-3">
      <h3 className="px-3 type-label text-text-2">{title}</h3>
      {children}
    </div>
  );
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

  const filePaths = useMemo(() => files.map((entry) => entry.path), [files]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ownership</CardTitle>
        <CardDescription>
          {files.length} indexed {files.length === 1 ? "file" : "files"} ·{" "}
          {commitCount} {commitCount === 1 ? "commit" : "commits"}
          {data?.shallow ? " (limited history)" : ""}
        </CardDescription>
      </CardHeader>

      <CardContent flush>
        <SkeletonSwap
          loading={isLoading}
          fallback={<RowsSkeleton />}
          label="Reading git history"
        >
          {error && (
            <Empty reason="error" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>{error}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!error && !isLoading && data && commitCount === 0 && (
            <Empty reason="empty" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>
                  No git history is available for this clone, so ownership
                  cannot be worked out. Re-add the repository to fetch its
                  history.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!error && commitCount > 0 && files.length > 0 && (
            <div className="px-3 py-3">
              <Field>
                <FieldLabel>Who should I ask about a file?</FieldLabel>
                <ComboboxField
                  items={filePaths}
                  value={selectedPath || null}
                  onValueChange={(value) => setSelectedPath(value ?? "")}
                  placeholder="Choose a file..."
                  emptyText="No indexed file matches."
                  showClear
                  className="mono"
                />
              </Field>
            </div>
          )}

          {!error && file && (
            <Section
              title={
                file.commitCount === 0
                  ? "No commits touch this file."
                  : `Changed in ${file.commitCount} ${
                      file.commitCount === 1 ? "commit" : "commits"
                    }`
              }
            >
              <ItemGroup variant="plain" aria-label="Authors of this file">
                {file.authors.map((author) => (
                  <PersonRow
                    key={author.email || author.name}
                    name={author.name}
                    meta={`${author.count} ${
                      author.count === 1 ? "commit" : "commits"
                    } · ${String(author.lastChangedAt ?? "").slice(0, 10)}`}
                  />
                ))}
              </ItemGroup>
            </Section>
          )}

          {!error && !isLoading && hotspots.length > 0 && (
            <Section title={`Churn hotspots (${hotspots.length})`}>
              <ItemGroup variant="plain" aria-label="Churn hotspots">
                {hotspots.map((hotspot) => (
                  <PathRow
                    key={hotspot.path}
                    path={hotspot.path}
                    meta={`${hotspot.commitCount} ${
                      hotspot.commitCount === 1 ? "commit" : "commits"
                    }`}
                  />
                ))}
              </ItemGroup>
            </Section>
          )}

          {!error && !isLoading && recent.length > 0 && (
            <Section title={`Recently changed (${recent.length})`}>
              <ItemGroup variant="plain" aria-label="Recently changed files">
                {recent.map((entry) => (
                  <PathRow
                    key={entry.path}
                    path={entry.path}
                    meta={`${String(entry.lastChangedAt ?? "").slice(0, 10)}${
                      entry.lastAuthor?.name
                        ? ` · ${entry.lastAuthor.name}`
                        : ""
                    }`}
                  />
                ))}
              </ItemGroup>
            </Section>
          )}

          {!error && !isLoading && contributors.length > 0 && (
            <Section
              title={`Who has touched this most (${contributors.length})`}
            >
              <ItemGroup variant="plain" aria-label="Top contributors">
                {contributors.slice(0, 8).map((contributor) => (
                  <PersonRow
                    key={contributor.email || contributor.name}
                    name={contributor.name}
                    meta={`${contributor.commitCount} ${
                      contributor.commitCount === 1 ? "commit" : "commits"
                    } · ${contributor.fileCount} ${
                      contributor.fileCount === 1 ? "file" : "files"
                    }`}
                  />
                ))}
              </ItemGroup>
            </Section>
          )}
        </SkeletonSwap>
      </CardContent>
    </Card>
  );
}
