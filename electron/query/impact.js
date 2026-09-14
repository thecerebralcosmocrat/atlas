// Answers the reverse of the I7 graph: what imports a file, what depends on it
// transitively, which symbols a name refers to, and which files no entry point
// can reach.
//
// The graph reasoning is pure so it can be tested without a database, mirroring
// query/graph.js and query/entrypoints.js. `getImpact` and
// `answerRepositoryGraphQuestion` are the DB-backed wrappers: both reuse
// getRepositoryGraph and detectEntryPoints rather than rebuilding the index.

const { getDb } = require("../db/schema");
const { toPosix } = require("../indexer/ImportResolver");
const { findRepoPrimaryKey, getRepositoryGraph } = require("./graph");
const {
  detectEntryPoints,
  isTestPath,
  readPackageJson,
} = require("./entrypoints");

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DEPENDENTS = 60;

// Chat intents. Order matters: "unused" must beat the symbol intent's "used",
// and "who imports X" is a file question even though it names a symbol.
const UNREACHABLE_INTENT =
  /\b(unreachable|reachable|orphans?|unused|dead\s+code|disconnected|isolated)\b|\bnot\s+(?:used|referenced|imported|reachable)\b/i;
const FILE_INTENT =
  /\b(import|imports|imported|importers?|callers?|dependents?|depends?|dependenc(?:y|ies)|blast\s+radius|impact|break(?:s|ing)?|breakage)\b/i;
const SYMBOL_INTENT =
  /\b(uses?|used|usage|references?|referenced|referencing|calls?|called|defined|definitions?)\b/i;

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches a name only when it stands alone. `\b` cannot be used because it
// treats a leading `$` as punctuation, so a symbol like `$store` would never
// match; the lookarounds only exclude word characters and `$`.
function identifierPattern(name, flags = "") {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, flags);
}

// One pass over the graph yielding every lookup the impact questions need.
// External packages are ignored: impact is about files in this repository.
function buildImportIndex(graph) {
  const pathByNodeId = new Map();
  const fileIdByPath = new Map();
  const allPaths = new Set();

  for (const node of graph.nodes ?? []) {
    if (node.type !== "file") continue;

    const posixPath = toPosix(node.path);

    pathByNodeId.set(node.id, posixPath);
    // File node ids are "file:<numeric id>", so the id the renderer uses for a
    // path is the tail of the node id.
    if (!fileIdByPath.has(posixPath)) {
      fileIdByPath.set(posixPath, Number(String(node.id).slice("file:".length)));
    }
    allPaths.add(posixPath);
  }

  // directImporters: target path -> importer path -> { importType, specifiers }
  const directImporters = new Map();
  // forward: source path -> set of imported paths
  const forward = new Map();

  for (const edge of graph.edges ?? []) {
    if (edge.type !== "imports" || edge.external) continue;

    const sourcePath = pathByNodeId.get(edge.source);
    const targetPath = pathByNodeId.get(edge.target);

    if (sourcePath === undefined || targetPath === undefined) continue;

    if (!forward.has(sourcePath)) forward.set(sourcePath, new Set());
    forward.get(sourcePath).add(targetPath);

    const importers = directImporters.get(targetPath) ?? new Map();
    const record =
      importers.get(sourcePath) ?? { importType: edge.importType ?? "import", specifiers: new Set() };

    if (edge.specifier) record.specifiers.add(edge.specifier);

    importers.set(sourcePath, record);
    directImporters.set(targetPath, importers);
  }

  return { allPaths, directImporters, fileIdByPath, forward, pathByNodeId };
}

// Direct importers plus the transitive blast radius of changing a file, walked
// backwards over the import edges. Cycles terminate because every visited path
// is recorded before it is expanded.
function fileImpact({
  graph,
  path: filePath,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxDependents = DEFAULT_MAX_DEPENDENTS,
}) {
  if (!filePath) return null;

  const target = toPosix(filePath);

  if (target === "") return null;

  const { allPaths, directImporters, fileIdByPath } = buildImportIndex(graph);

  if (!allPaths.has(target)) return null;

  const importers = [...(directImporters.get(target) ?? new Map()).entries()]
    .map(([importerPath, record]) => ({
      path: importerPath,
      importType: record.importType,
      specifiers: [...record.specifiers].sort(compareText),
    }))
    .sort((left, right) => compareText(left.path, right.path));

  const seen = new Set([target]);
  const dependents = [];
  let frontier = [target];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = [];

    for (const current of frontier) {
      for (const importerPath of (directImporters.get(current) ?? new Map()).keys()) {
        if (seen.has(importerPath)) continue;

        seen.add(importerPath);
        next.push(importerPath);

        if (dependents.length < maxDependents) {
          dependents.push({ path: importerPath, distance: depth });
        }
      }
    }

    frontier = next;
  }

  dependents.sort(
    (left, right) =>
      left.distance - right.distance || compareText(left.path, right.path),
  );

  return {
    path: target,
    fileId: fileIdByPath.get(target) ?? null,
    importers,
    dependents,
  };
}

// Files no entry point can reach by following imports. Returns nothing when
// there are no entry points to start from, so an un-indexed or entry-less
// repository does not report every file as dead code.
function findUnreachableFiles({ graph, entryPaths = [] }) {
  const entries = entryPaths.map((entryPath) => toPosix(entryPath));

  if (entries.length === 0) return [];

  const { allPaths, forward } = buildImportIndex(graph);
  const visited = new Set(entries);
  const queue = entries.filter((entryPath) => allPaths.has(entryPath));

  for (let index = 0; index < queue.length; index += 1) {
    for (const next of forward.get(queue[index]) ?? []) {
      if (visited.has(next)) continue;

      visited.add(next);
      queue.push(next);
    }
  }

  // Tests are expected to sit outside the entry-point reachability tree, so
  // excluding them keeps the signal on application code.
  return [...allPaths]
    .filter((filePath) => !visited.has(filePath) && !isTestPath(filePath))
    .sort(compareText);
}

// Definitions are exact name matches from the symbol table; references are a
// word-boundary scan of file contents, which is the best signal the graph has
// until references become their own edge type.
function findSymbolDefinitions({ symbols = [], name }) {
  const target = String(name ?? "").toLowerCase();

  if (!target) return [];

  return symbols
    .filter((symbol) => String(symbol.name ?? "").toLowerCase() === target)
    .map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind ?? "symbol",
      fileId: symbol.file_id ?? null,
      path: symbol.path === undefined || symbol.path === null ? null : toPosix(symbol.path),
      lineStart: symbol.line_start,
      lineEnd: symbol.line_end,
      isExported: symbol.is_exported === 1 || symbol.is_exported === true,
    }))
    .sort(
      (left, right) =>
        compareText(left.path, right.path) || left.lineStart - right.lineStart,
    );
}

// Lines inside a definition's own range are not "usages", so they are skipped.
function findSymbolReferences({ contents = [], name, definitions = [] }) {
  const symbolName = String(name ?? "");

  if (!symbolName) return [];

  const pattern = identifierPattern(symbolName);
  const rangesByPath = new Map();

  for (const definition of definitions) {
    if (!definition.path) continue;

    const ranges = rangesByPath.get(definition.path) ?? [];

    ranges.push([definition.lineStart, definition.lineEnd]);
    rangesByPath.set(definition.path, ranges);
  }

  const references = [];

  for (const file of contents) {
    const filePath = toPosix(file.path);
    const lines = String(file.raw_content ?? "").split(/\r?\n/);
    const lineNumbers = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue;

      const lineNumber = index + 1;
      const isDefinitionLine = (rangesByPath.get(filePath) ?? []).some(
        ([start, end]) => lineNumber >= start && lineNumber <= end,
      );

      if (!isDefinitionLine) lineNumbers.push(lineNumber);
    }

    if (lineNumbers.length > 0) references.push({ path: filePath, lines: lineNumbers });
  }

  return references.sort((left, right) => compareText(left.path, right.path));
}

function detectGraphIntent(question) {
  const text = String(question ?? "");

  if (UNREACHABLE_INTENT.test(text)) return "unreachable";
  if (FILE_INTENT.test(text)) return "file";
  if (SYMBOL_INTENT.test(text)) return "symbol";

  return null;
}

// Picks the file or symbol a question is about. A full path beats a basename,
// a basename beats a symbol name, and longer names beat shorter ones, so
// "who imports src/util.js" resolves the path rather than the `util` symbol.
function resolveGraphTarget({ question, files = [], symbols = [] }) {
  const lower = String(question ?? "").toLowerCase();

  if (!lower) return null;

  let bestPath = null;

  for (const file of files) {
    if (file?.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);
    const candidate = posixPath.toLowerCase();

    if (candidate.length === 0 || !lower.includes(candidate)) continue;

    if (bestPath === null || candidate.length > bestPath.length) {
      bestPath = posixPath;
    }
  }

  if (bestPath !== null) return { kind: "file", path: bestPath };

  const basenameMatches = [];

  for (const file of files) {
    if (file?.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);
    const base = posixPath.slice(posixPath.lastIndexOf("/") + 1);
    const stem = base.replace(/\.[a-z0-9]+$/i, "");
    const matchesBase =
      base.length >= 3 && identifierPattern(base, "i").test(lower);
    const matchesStem =
      !matchesBase &&
      stem.length >= 3 &&
      identifierPattern(stem, "i").test(lower);

    if (matchesBase || matchesStem) {
      basenameMatches.push({ path: posixPath, exact: matchesBase });
    }
  }

  if (basenameMatches.length > 0) {
    // An exact basename is stronger evidence than a stem shared by many files.
    basenameMatches.sort((left, right) => {
      if (left.exact !== right.exact) return left.exact ? -1 : 1;
      return left.path.length - right.path.length || compareText(left.path, right.path);
    });

    return { kind: "file", path: basenameMatches[0].path };
  }

  const names = new Map();

  for (const symbol of symbols) {
    const symbolName = String(symbol?.name ?? "");

    if (symbolName.length < 3) continue;

    if (identifierPattern(symbolName, "i").test(lower)) {
      const key = symbolName.toLowerCase();

      if (!names.has(key)) names.set(key, symbolName);
    }
  }

  if (names.size > 0) {
    const [name] = [...names.values()].sort(
      (left, right) => right.length - left.length || compareText(left, right),
    );

    return { kind: "symbol", name };
  }

  return null;
}

// Renders a bulleted list capped at ten entries, noting how many were hidden.
function bulletList(items) {
  const shown = items.slice(0, 10);
  const lines = shown.map((item) => `- ${item}`);
  const remaining = items.length - shown.length;

  if (remaining > 0) lines.push(`- …and ${remaining} more.`);

  return lines;
}

function formatFileImpact(impact) {
  const lines = [];

  if (impact.importers.length === 0) {
    lines.push(
      `Nothing in the index imports \`${impact.path}\`, so it is either an entry point or unused.`,
    );
  } else {
    lines.push(
      `\`${impact.path}\` is imported directly by ${impact.importers.length} ${
        impact.importers.length === 1 ? "file" : "files"
      }:`,
      "",
      ...impact.importers.map(
        (importer) => `- \`${importer.path}\` (${importer.importType})`,
      ),
    );
  }

  const indirect = impact.dependents.filter((dependent) => dependent.distance > 1);

  if (impact.dependents.length > 0) {
    lines.push(
      "",
      `Changing it can affect ${impact.dependents.length} ${
        impact.dependents.length === 1 ? "file" : "files"
      } in total (${impact.importers.length} direct, ${indirect.length} indirect).`,
    );

    if (indirect.length > 0) {
      lines.push(
        "",
        "Indirectly affected:",
        ...bulletList(
          indirect.map(
            (dependent) => `\`${dependent.path}\` (${dependent.distance} hops)`,
          ),
        ),
      );
    }
  }

  return lines.join("\n");
}

function formatSymbolUsage({ target, definitions, references }) {
  const definitionLines = definitions.map(
    (definition) =>
      `- \`${definition.path}\` (L${definition.lineStart}${
        definition.lineEnd > definition.lineStart ? `–${definition.lineEnd}` : ""
      }, ${definition.kind}${definition.isExported ? ", exported" : ""})`,
  );

  const lines = [
    definitions.length === 1
      ? `\`${target.name}\` is defined in 1 place:`
      : `\`${target.name}\` is defined in ${definitions.length} places:`,
    "",
    ...definitionLines,
  ];

  if (references.length === 0) {
    lines.push("", "It is not referenced anywhere else in the index.");
    return lines.join("\n");
  }

  lines.push(
    "",
    `It is referenced in ${references.length} ${
      references.length === 1 ? "file" : "files"
    }:`,
    "",
    ...references.slice(0, 10).map((reference) => {
      const shown = reference.lines.slice(0, 5);
      const remaining = reference.lines.length - shown.length;
      const lineList = shown.join(", ") + (remaining > 0 ? `, +${remaining} more` : "");

      return `- \`${reference.path}\` (line${shown.length === 1 ? "" : "s"} ${lineList})`;
    }),
  );

  return lines.join("\n");
}

// Grounds impact, symbol-usage, and unreachability questions in the graph so
// the answer is deterministic instead of a lexical guess. Returns null when the
// question is not one of those or names nothing in the index, letting the
// caller fall back to retrieval and the model.
function answerGraphQuestion({
  question,
  intent,
  target,
  graph,
  files = [],
  symbols = [],
  contents = [],
  entryPaths = [],
}) {
  const resolvedIntent = intent ?? detectGraphIntent(question);

  if (!resolvedIntent) return null;

  if (resolvedIntent === "unreachable") {
    if (entryPaths.length === 0) {
      return "I could not find any entry points in this repository, so I cannot tell which files are unreachable. Add a `main` to package.json or an `index`/`main` module and re-index.";
    }

    const unreachable = findUnreachableFiles({ graph, entryPaths });

    if (unreachable.length === 0) {
      return "Every indexed source file is reachable from an entry point.";
    }

    return [
      `${unreachable.length} indexed ${
        unreachable.length === 1 ? "file is" : "files are"
      } not reachable from any entry point:`,
      "",
      ...bulletList(unreachable.map((filePath) => `\`${filePath}\``)),
      "",
      "They may be dead code, standalone scripts, or only reached at runtime.",
    ].join("\n");
  }

  const resolvedTarget =
    target ?? resolveGraphTarget({ question, files, symbols });

  if (!resolvedTarget) return null;

  if (resolvedTarget.kind === "file") {
    const impact = fileImpact({ graph, path: resolvedTarget.path });

    return impact ? formatFileImpact(impact) : null;
  }

  const definitions = findSymbolDefinitions({
    symbols,
    name: resolvedTarget.name,
  });

  if (definitions.length === 0) return null;

  const references = findSymbolReferences({
    contents,
    name: resolvedTarget.name,
    definitions,
  });

  return formatSymbolUsage({ target: resolvedTarget, definitions, references });
}

function loadFileRows(repoId) {
  return getDb()
    .prepare(
      `SELECT id, path, instr(raw_content, '__main__') > 0 AS hasMainGuard
         FROM files
        WHERE repo_id = ?
        ORDER BY path`,
    )
    .all(repoId);
}

function loadSymbolRows(repoId) {
  return getDb()
    .prepare(
      `SELECT s.id, s.file_id, s.name, s.kind, s.line_start, s.line_end,
              s.is_exported, f.path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE f.repo_id = ?`,
    )
    .all(repoId);
}

function getRootPath(repoId) {
  return getDb()
    .prepare("SELECT root_path FROM repos WHERE id = ?")
    .get(repoId)?.root_path;
}

function resolveEntryPaths(repoId, fileRows) {
  return detectEntryPoints({
    files: fileRows,
    packageJson: readPackageJson(getRootPath(repoId)),
  }).map((entry) => entry.path);
}

// The Explorer's impact view: every indexed path for the picker, the
// repository-wide unreachable list, and (when a file is chosen) its importers
// and blast radius.
function getImpact(repositoryId, filePath) {
  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) {
    return { files: [], unreachable: [], hasEntryPoints: false, impact: null };
  }

  const fileRows = loadFileRows(repoId);
  const graph = getRepositoryGraph(repositoryId);
  const entryPaths = resolveEntryPaths(repoId, fileRows);

  return {
    files: fileRows.map((file) => ({ id: file.id, path: toPosix(file.path) })),
    unreachable: findUnreachableFiles({ graph, entryPaths }),
    hasEntryPoints: entryPaths.length > 0,
    impact: filePath ? fileImpact({ graph, path: filePath }) : null,
  };
}

// The chat path. Only loads file contents when the question resolved to a
// symbol, since references need them and file impact does not.
function answerRepositoryGraphQuestion(repositoryId, question) {
  const intent = detectGraphIntent(question);

  if (!intent) return null;

  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return null;

  const fileRows = loadFileRows(repoId);
  const symbols = loadSymbolRows(repoId);
  const graph = getRepositoryGraph(repositoryId);

  if (intent === "unreachable") {
    return answerGraphQuestion({
      question,
      intent,
      graph,
      files: fileRows,
      symbols,
      entryPaths: resolveEntryPaths(repoId, fileRows),
    });
  }

  const target = resolveGraphTarget({ question, files: fileRows, symbols });

  if (!target) return null;

  const contents =
    target.kind === "symbol"
      ? getDb()
          .prepare("SELECT path, raw_content FROM files WHERE repo_id = ?")
          .all(repoId)
      : [];

  return answerGraphQuestion({
    question,
    intent,
    target,
    graph,
    files: fileRows,
    symbols,
    contents,
  });
}

module.exports = {
  answerGraphQuestion,
  answerRepositoryGraphQuestion,
  detectGraphIntent,
  fileImpact,
  findSymbolDefinitions,
  findSymbolReferences,
  findUnreachableFiles,
  getImpact,
  resolveGraphTarget,
};
