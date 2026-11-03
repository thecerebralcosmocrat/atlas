import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/glaze/ui/card";
import { Badge } from "@/components/glaze/ui/badge";
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
  ItemTitle,
} from "@/components/glaze/ui/item";
import { Skeleton, SkeletonSwap } from "@/components/glaze/ui/skeleton";
import { Truncate } from "@/components/glaze/ui/truncate";

function getImpactApi() {
  return window.electronAPI?.graph?.impact;
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

function PathRow({ path, tag }) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          <Truncate position="middle" className="mono">
            {path}
          </Truncate>
        </ItemTitle>
      </ItemContent>
      {tag && <Badge>{tag}</Badge>}
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

function Note({ children }) {
  return <p className="px-3 type-body-sm text-text-2">{children}</p>;
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

  const filePaths = useMemo(() => files.map((file) => file.path), [files]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Impact</CardTitle>
        <CardDescription>
          {files.length} indexed {files.length === 1 ? "file" : "files"} ·{" "}
          {unreachable.length} not reachable from an entry point
        </CardDescription>
      </CardHeader>

      <CardContent flush>
        <SkeletonSwap
          loading={isLoading}
          fallback={<RowsSkeleton />}
          label="Analyzing repository"
        >
          {error && (
            <Empty reason="error" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>{error}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!error && !isLoading && files.length === 0 && (
            <Empty reason="empty" variant="plain" size="sm">
              <EmptyHeader>
                <EmptyTitle>
                  No indexed files to analyze. Re-index this repository.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {files.length > 0 && (
            <div className="px-3 py-3">
              <Field>
                <FieldLabel>What does changing a file affect?</FieldLabel>
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

          {!error && impact && (
            <>
              <Section
                title={`Imported directly by (${impact.importers.length})`}
              >
                {impact.importers.length === 0 ? (
                  <Note>Nothing in the index imports this file.</Note>
                ) : (
                  <ItemGroup variant="plain" aria-label="Importers">
                    {impact.importers.map((importer) => (
                      <PathRow
                        key={importer.path}
                        path={importer.path}
                        tag={importer.importType}
                      />
                    ))}
                  </ItemGroup>
                )}
              </Section>

              <Section title={`Blast radius (${impact.dependents.length})`}>
                {impact.dependents.length === 0 ? (
                  <Note>No other indexed file depends on it.</Note>
                ) : (
                  <ItemGroup variant="plain" aria-label="Dependents">
                    {impact.dependents.slice(0, 20).map((dependent) => (
                      <PathRow
                        key={dependent.path}
                        path={dependent.path}
                        tag={`${dependent.distance} hop${
                          dependent.distance === 1 ? "" : "s"
                        }`}
                      />
                    ))}
                  </ItemGroup>
                )}
              </Section>
            </>
          )}

          {!error && !isLoading && unreachable.length > 0 && (
            <Section
              title={`Not reachable from an entry point (${unreachable.length})`}
            >
              <ItemGroup variant="plain" aria-label="Unreachable files">
                {unreachable.slice(0, 12).map((filePath) => (
                  <PathRow key={filePath} path={filePath} />
                ))}
              </ItemGroup>
              {unreachable.length > 12 && (
                <Note>...and {unreachable.length - 12} more</Note>
              )}
            </Section>
          )}

          {!error && !isLoading && data && !data.hasEntryPoints && (
            <div className="py-3">
              <Note>
                No entry points were found, so reachability cannot be judged
                yet.
              </Note>
            </div>
          )}
        </SkeletonSwap>
      </CardContent>
    </Card>
  );
}
