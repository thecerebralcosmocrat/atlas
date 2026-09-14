import { useEffect, useMemo, useRef, useState } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  useNavigate,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import { Button } from "@/components/ui/button";
import {
  Link as LinkIcon,
  Plus,
  ArrowUp,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Globe,
  BookOpen,
  Info,
} from "lucide-react";

function getRepositoryApi() {
  return window.electronAPI?.repositories;
}

function formatDate(value) {
  if (!value) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

const onboardingPrompts = [
  "What does this repo do?",
  "How do I run this?",
  "What should I read first?",
];

function RepositoryChat({ repository, onAskRepository }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [isAsking, setIsAsking] = useState(false);
  const messagesRef = useRef(null);

  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content:
          "Ask me onboarding questions about this codebase. I can help with the project overview, run commands, structure, and where to start reading.",
      },
    ]);
    setQuestion("");
  }, [repository?.id]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const askQuestion = async (nextQuestion = question) => {
    const trimmedQuestion = nextQuestion.trim();

    if (!trimmedQuestion || isAsking) return;

    setQuestion("");
    setIsAsking(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", content: trimmedQuestion },
    ]);

    try {
      const answer = await onAskRepository(repository.id, trimmedQuestion);

      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          role: "assistant",
          content:
            err.message || "I could not answer that yet. Try another question.",
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <section className="mt-6 flex min-h-[360px] flex-col rounded-[calc(var(--radius)+1rem)] border border-border bg-card p-3 shadow-sm">
      <div className="px-2 pb-3 pt-1 text-center">
        <h2 className="text-xl font-semibold tracking-[-0.055em] text-foreground">
          Ready when you are.
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask onboarding questions about {repository.name}.
        </p>
      </div>

      <div
        ref={messagesRef}
        className="flex max-h-[260px] flex-1 flex-col gap-3 overflow-y-auto px-1 py-2"
      >
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={
              message.role === "user"
                ? "ml-auto max-w-[78%] rounded-[calc(var(--radius)+0.75rem)] bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground"
                : "mr-auto max-w-[82%] rounded-[calc(var(--radius)+0.75rem)] border border-border bg-background px-4 py-3 text-sm leading-relaxed text-foreground"
            }
          >
            <div className="whitespace-pre-wrap">{message.content}</div>
          </div>
        ))}
        {isAsking && (
          <div className="mr-auto rounded-[calc(var(--radius)+0.75rem)] border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
            Thinking...
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {onboardingPrompts.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            className="rounded-full"
            disabled={isAsking}
            onClick={() => askQuestion(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>

      <div className="mt-3 flex h-14 items-center rounded-full border border-border bg-background px-2 shadow-sm transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Add context"
        >
          <Plus />
        </Button>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") askQuestion();
          }}
          placeholder="Ask anything about this codebase"
          className="h-full min-w-0 flex-1 border-none bg-transparent px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          disabled={isAsking}
        />
        <Button
          type="button"
          variant="default"
          size="icon"
          className="rounded-full"
          disabled={isAsking || !question.trim()}
          onClick={() => askQuestion()}
          aria-label="Send question"
        >
          <ArrowUp />
        </Button>
      </div>
    </section>
  );
}

function Home({
  repositories,
  selectedRepository,
  selectedDetails,
  onAskRepository,
}) {
  const navigate = useNavigate();

  if (repositories.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            No repositories yet
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add a GitHub repository to clone it locally and start exploring its
            files.
          </p>
          <Button className="mt-6 rounded-full" onClick={() => navigate("/")}>
            Add repository
          </Button>
        </div>
      </div>
    );
  }

  const repository = selectedRepository || repositories[0];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Current repository
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
          {repository.name}
        </h1>
        <p className="mt-2 max-w-2xl truncate text-sm text-muted-foreground">
          {repository.url}
        </p>

        <div className="mt-6 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold tabular-nums">
                {selectedDetails?.fileCount ?? "-"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Files</div>
            </div>
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold tabular-nums">
                {selectedDetails?.directoryCount ?? "-"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Folders</div>
            </div>
            <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
              <div className="text-2xl font-semibold">
                {formatDate(repository.addedAt)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Indexed</div>
            </div>
          </div>

          <div className="rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-foreground">
                  Local clone
                </h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {repository.localPath}
                </p>
              </div>
              <Button
                className="rounded-full"
                onClick={() => navigate("/explorer")}
              >
                Open explorer
              </Button>
            </div>
          </div>
        </div>

        <RepositoryChat
          repository={repository}
          onAskRepository={onAskRepository}
        />
      </div>
    </div>
  );
}

function FileTree({ items, depth = 0 }) {
  if (!items?.length) return null;

  return (
    <div
      className={
        depth === 0 ? "flex flex-col gap-1" : "mt-1 flex flex-col gap-1"
      }
    >
      {items.map((item) => (
        <div key={`${depth}-${item.name}`}>
          <div
            className="rounded-lg px-2 py-1.5 text-sm text-muted-foreground"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <span className="text-foreground">{item.name}</span>
            <span className="ml-2 text-[11px] uppercase tracking-wide">
              {item.type}
            </span>
          </div>
          {item.children?.length > 0 && (
            <FileTree items={item.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

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
      // Symbol nodes carry the numeric file id, and file node ids are
      // "file:<id>", so the two can be joined without another lookup.
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
          other?.label ?? edge.specifier ?? (direction === "outbound" ? edge.target : edge.source);

        return (
          <li
            key={`${edge.specifier ?? "edge"}-${index}`}
            className="flex items-center gap-2"
          >
            <span className="truncate text-foreground">{label}</span>
            {edge.importType && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                {edge.importType}
              </span>
            )}
            {edge.external && (
              <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                external
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CodeGraphPanel({ repository }) {
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
    <div className="mt-6 rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-3 shadow-sm">
      <div className="px-1 pb-3">
        <h2 className="text-sm font-medium text-foreground">Code graph</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {fileNodes.length} files · {symbolCount} symbols · {externalCount}{" "}
          external packages
        </p>
      </div>

      {isLoading && (
        <div className="px-1 pb-1 text-sm text-muted-foreground">
          Building graph...
        </div>
      )}

      {error && (
        <div className="px-1 pb-1 text-sm text-destructive">{error}</div>
      )}

      {!isLoading && !error && fileNodes.length === 0 && (
        <div className="px-1 pb-1 text-sm text-muted-foreground">
          No symbols or imports were found. Re-index this repository to build
          the graph.
        </div>
      )}

      {!isLoading && !error && fileNodes.length > 0 && (
        <div className="flex flex-col gap-1">
          {fileNodes.map((file) => {
            const isOpen = expandedId === file.id;
            const symbols = symbolsByFile.get(file.id) ?? [];
            const { outbound = [], inbound = [] } =
              importsByFile.get(file.id) ?? {};
            const Chevron = isOpen ? ChevronDown : ChevronRight;

            return (
              <div
                key={file.id}
                className="rounded-lg border border-transparent transition-colors duration-150 ease-out hover:border-border"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpandedId(isOpen ? null : file.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
                >
                  <Chevron className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-foreground">{file.path}</span>
                  <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {symbols.length} sym · {outbound.length} out ·{" "}
                    {inbound.length} in
                  </span>
                </button>

                {isOpen && (
                  <div className="mx-2 mb-2 ml-6 flex flex-col gap-3 rounded-lg bg-muted/40 p-3 text-xs">
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
                              <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {symbol.type}
                              </span>
                              <span className="truncate text-foreground">
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
    </div>
  );
}

function getStartHereApi() {
  return window.electronAPI?.graph?.startHere;
}

function StartHerePanel({ repository }) {
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
    <div className="mt-6 rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-3 shadow-sm">
      <div className="px-1 pb-3">
        <h2 className="text-sm font-medium text-foreground">Start here</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {entryCount} entry {entryCount === 1 ? "point" : "points"} ·{" "}
          {readingPath.length} {readingPath.length === 1 ? "file" : "files"}{" "}
          to read
        </p>
      </div>

      {isLoading && (
        <div className="px-1 pb-1 text-sm text-muted-foreground">
          Finding entry points...
        </div>
      )}

      {error && (
        <div className="px-1 pb-1 text-sm text-destructive">{error}</div>
      )}

      {!isLoading && !error && readingPath.length === 0 && (
        <div className="px-1 pb-1 text-sm text-muted-foreground">
          No entry points or imports were found. Re-index this repository to
          build the reading path.
        </div>
      )}

      {!isLoading && !error && readingPath.length > 0 && (
        <ol className="flex flex-col gap-1">
          {readingPath.map((item, index) => (
            <li
              key={item.path}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
                {index + 1}
              </span>
              <span className="truncate text-foreground">{item.path}</span>
              {item.isEntry ? (
                <span className="ml-auto shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.reason}
                </span>
              ) : (
                <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {item.fanIn} importer{item.fanIn === 1 ? "" : "s"}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function getImpactApi() {
  return window.electronAPI?.graph?.impact;
}

function ImpactPanel({ repository }) {
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
    <div className="mt-6 rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-3 shadow-sm">
      <div className="px-1 pb-3">
        <h2 className="text-sm font-medium text-foreground">Impact</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {files.length} indexed {files.length === 1 ? "file" : "files"} ·{" "}
          {unreachable.length} not reachable from an entry point
        </p>
      </div>

      {error && (
        <div className="px-1 pb-1 text-sm text-destructive">{error}</div>
      )}

      {!error && !isLoading && files.length === 0 && (
        <div className="px-1 pb-1 text-sm text-muted-foreground">
          No indexed files to analyze. Re-index this repository.
        </div>
      )}

      {files.length > 0 && (
        <div className="px-1 pb-3">
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
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
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
        <div className="mx-1 flex flex-col gap-3 rounded-lg bg-muted/40 p-3 text-xs">
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
                    <span className="truncate text-foreground">
                      {importer.path}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
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
                    <span className="truncate text-foreground">
                      {dependent.path}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
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
        <div className="mx-1 mt-3 rounded-lg bg-muted/40 p-3 text-xs">
          <div className="font-medium text-muted-foreground">
            Not reachable from an entry point ({unreachable.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {unreachable.slice(0, 12).map((filePath) => (
              <li key={filePath} className="truncate text-foreground">
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
        <div className="px-1 pt-3 text-xs text-muted-foreground">
          No entry points were found, so reachability cannot be judged yet.
        </div>
      )}
    </div>
  );
}

function Explorer({ selectedRepository, selectedDetails, isInspecting }) {
  const navigate = useNavigate();

  if (!selectedRepository) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground">
            Choose a repository
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add or select a repository to browse its files.
          </p>
          <Button className="mt-6 rounded-full" onClick={() => navigate("/")}>
            Add repository
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <Button
          variant="ghost"
          className="mb-4 -ml-3 rounded-full"
          onClick={() => navigate("/home")}
        >
          <ArrowLeft className="mr-1.5 size-4" />
          Back
        </Button>
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Explorer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
          {selectedRepository.name}
        </h1>
        <div className="mt-6 rounded-[calc(var(--radius)+0.75rem)] border border-border bg-card p-3 shadow-sm">
          {isInspecting ? (
            <div className="p-3 text-sm text-muted-foreground">
              Reading repository files...
            </div>
          ) : (
            <FileTree items={selectedDetails?.tree ?? []} />
          )}
        </div>

        <StartHerePanel repository={selectedRepository} />
        <CodeGraphPanel repository={selectedRepository} />
        <ImpactPanel
          key={selectedRepository.id}
          repository={selectedRepository}
        />
      </div>
    </div>
  );
}

function Onboarding({ onAddRepository }) {
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
        "Opening repository dashboard...",
      ]);
      navigate("/home");
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
    if (!window.electronAPI?.repositories?.onIndexProgress) return;
    const unsubscribe = window.electronAPI.repositories.onIndexProgress(
      (data) => {
        setProgress(data);
      }
    );
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center">
        <div className="mb-8 text-center">
          <h2 className="mb-2 text-3xl font-semibold tracking-[-0.055em] text-foreground">
            Index a repository
          </h2>
          <p className="text-sm text-muted-foreground">
            Paste a GitHub URL to get started
          </p>
        </div>

        {/* URL Input Area */}
        <div className="w-full">
          <div className="relative flex h-14 items-center rounded-full border border-border bg-card px-2 shadow-sm transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <Button
              variant="ghost"
              size="icon"
              className="flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-5 w-5" />
            </Button>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo"
              className="h-full flex-1 border-none bg-transparent px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleIndex();
              }}
            />
            <div className="flex flex-shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <LinkIcon className="h-5 w-5" />
              </Button>
              <Button
                variant="default"
                size="icon"
                className="rounded-full"
                onClick={handleIndex}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Suggestion Chips */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <Globe className="h-4 w-4" />
              <span>Try a public repo</span>
            </button>
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <BookOpen className="h-4 w-4" />
              <span>Browse examples</span>
            </button>
            <button className="flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              <Info className="h-4 w-4" />
              <span>Learn more</span>
            </button>
          </div>

          {/* Progress Log */}
          {isIndexing && (
            <div
              ref={logContainerRef}
              className="mt-4 h-40 overflow-y-auto rounded-[calc(var(--radius)+0.5rem)] border border-border bg-card p-4 shadow-sm"
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
            <div className="mt-4 rounded-[calc(var(--radius)+0.5rem)] border border-border bg-card p-4 shadow-sm">
              <div className="flex justify-between items-center mb-2 text-sm text-muted-foreground">
                <span className="truncate">
                  {progress.currentFile
                    ? progress.currentFile.length > 40
                      ? progress.currentFile.slice(-40)
                      : progress.currentFile
                    : "Preparing…"}
                </span>
                <span className="font-medium shrink-0 ml-4">
                  {progress.completed} / {progress.total} files
                </span>
              </div>
              <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-300 ease-out"
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
            <div className="mt-4 rounded-[calc(var(--radius)+0.5rem)] border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Layout({
  children,
  repositories,
  selectedRepositoryId,
  onSelectRepository,
}) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background font-sans text-foreground antialiased selection:bg-accent selection:text-foreground">
      <Sidebar
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
        onSelectRepository={onSelectRepository}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Custom Titlebar Drag Region */}
        <div
          className="shrink-0 w-full h-8"
          style={{ WebkitAppRegion: "drag" }}
        />

        <main className="flex-1 flex flex-col bg-background overflow-hidden">
          {/* Page Content */}
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const [repositories, setRepositories] = useState([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  // Bumped when the main process finishes indexing repositories in the
  // background, which re-runs the list + inspect effects below.
  const [refreshToken, setRefreshToken] = useState(0);
  const repositoryApi = useMemo(getRepositoryApi, []);

  useEffect(() => {
    async function loadRepositories() {
      if (!repositoryApi) return;

      const storedRepositories = await repositoryApi.list();
      setRepositories(storedRepositories);

      if (storedRepositories.length > 0) {
        setSelectedRepositoryId(
          (currentId) => currentId || storedRepositories[0].id,
        );
      }
    }

    loadRepositories();
  }, [repositoryApi, refreshToken]);

  useEffect(() => {
    if (!repositoryApi?.onChanged) return undefined;

    return repositoryApi.onChanged(() =>
      setRefreshToken((currentToken) => currentToken + 1),
    );
  }, [repositoryApi]);

  useEffect(() => {
    async function inspectSelectedRepository() {
      if (!repositoryApi || !selectedRepositoryId) {
        setSelectedDetails(null);
        return;
      }

      setIsInspecting(true);

      try {
        setSelectedDetails(await repositoryApi.inspect(selectedRepositoryId));
      } finally {
        setIsInspecting(false);
      }
    }

    inspectSelectedRepository();
  }, [repositoryApi, selectedRepositoryId, refreshToken]);

  const selectedRepository =
    repositories.find((repository) => repository.id === selectedRepositoryId) ||
    null;

  const handleAddRepository = async (repositoryUrl) => {
    if (!repositoryApi) {
      throw new Error(
        "Repository indexing is only available in the Electron app.",
      );
    }

    const repository = await repositoryApi.add(repositoryUrl);
    setRepositories((currentRepositories) => [
      repository,
      ...currentRepositories.filter((item) => item.id !== repository.id),
    ]);
    setSelectedRepositoryId(repository.id);
    setSelectedDetails(repository);

    return repository;
  };

  const handleAskRepository = async (repositoryId, question) => {
    if (!repositoryApi) {
      throw new Error("Repository Q&A is only available in the Electron app.");
    }

    return repositoryApi.ask(repositoryId, question);
  };

  return (
    <TooltipProvider>
      <Router>
        <Layout
          repositories={repositories}
          selectedRepositoryId={selectedRepositoryId}
          onSelectRepository={setSelectedRepositoryId}
        >
          <Routes>
            <Route
              path="/"
              element={<Onboarding onAddRepository={handleAddRepository} />}
            />
            <Route
              path="/home"
              element={
                <Home
                  repositories={repositories}
                  selectedRepository={selectedRepository}
                  selectedDetails={selectedDetails}
                  onAskRepository={handleAskRepository}
                />
              }
            />
            <Route
              path="/explorer"
              element={
                <Explorer
                  selectedRepository={selectedRepository}
                  selectedDetails={selectedDetails}
                  isInspecting={isInspecting}
                />
              }
            />
          </Routes>
        </Layout>
      </Router>
    </TooltipProvider>
  );
}
