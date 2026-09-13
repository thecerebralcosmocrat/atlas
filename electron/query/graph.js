// Reads the symbol/import graph for a repository.
//
// Files are the top-level nodes; their symbols hang off `contains` edges, and
// imports connect files (or a synthetic node for an external package). The
// builder is pure so the shape can be tested without a database.

const { getDb } = require("../db/schema");

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function buildGraph({ files = [], symbols = [], imports = [] }) {
  const fileById = new Map(files.map((file) => [file.id, file]));
  const symbolCountByFile = new Map();

  for (const symbol of symbols) {
    symbolCountByFile.set(
      symbol.file_id,
      (symbolCountByFile.get(symbol.file_id) ?? 0) + 1,
    );
  }

  const sortedFiles = [...files].sort((a, b) => compareText(a.path, b.path));
  const sortedSymbols = [...symbols].sort(
    (a, b) =>
      a.file_id - b.file_id ||
      a.line_start - b.line_start ||
      compareText(a.name, b.name),
  );

  const nodes = sortedFiles.map((file) => ({
    id: `file:${file.id}`,
    type: "file",
    label: file.path,
    path: file.path,
    language: file.language ?? "",
    symbolCount: symbolCountByFile.get(file.id) ?? 0,
  }));

  for (const symbol of sortedSymbols) {
    const file = fileById.get(symbol.file_id);

    nodes.push({
      id: `symbol:${symbol.id}`,
      type: symbol.kind,
      label: symbol.name,
      fileId: symbol.file_id,
      path: file?.path ?? null,
      lineStart: symbol.line_start,
      lineEnd: symbol.line_end,
      isExported: symbol.is_exported === 1,
    });
  }

  const edges = [];
  const seenEdges = new Set();

  function pushEdge(edge) {
    const key = `${edge.type}|${edge.source}|${edge.target}|${
      edge.specifier ?? ""
    }`;

    if (seenEdges.has(key)) return;

    seenEdges.add(key);
    edges.push(edge);
  }

  for (const symbol of sortedSymbols) {
    pushEdge({
      type: "contains",
      source: `file:${symbol.file_id}`,
      target: `symbol:${symbol.id}`,
    });
  }

  // External packages appear once, as a target node they all share.
  const externalNodes = new Map();

  for (const imported of imports) {
    const source = `file:${imported.source_file_id}`;
    const hasTarget =
      imported.target_file_id !== null &&
      imported.target_file_id !== undefined &&
      fileById.has(imported.target_file_id);

    if (hasTarget) {
      pushEdge({
        type: "imports",
        source,
        target: `file:${imported.target_file_id}`,
        specifier: imported.import_specifier,
        importType: imported.import_type ?? "import",
        external: false,
      });
      continue;
    }

    const specifier = imported.import_specifier;

    if (!externalNodes.has(specifier)) {
      externalNodes.set(specifier, {
        id: `external:${specifier}`,
        type: "external",
        label: specifier,
      });
    }

    pushEdge({
      type: "imports",
      source,
      target: `external:${specifier}`,
      specifier,
      importType: imported.import_type ?? "import",
      external: true,
    });
  }

  for (const node of [...externalNodes.values()].sort((a, b) =>
    compareText(a.label, b.label),
  )) {
    nodes.push(node);
  }

  return { nodes, edges };
}

// Resolves the renderer's external id first and only falls back to the numeric
// primary key when no external id matches, mirroring searchRepositoryFiles.
function findRepoPrimaryKey(repositoryId) {
  if (repositoryId === undefined || repositoryId === null) return null;

  const db = getDb();
  const byExternalId = db
    .prepare("SELECT id FROM repos WHERE external_id = ?")
    .get(String(repositoryId));

  if (byExternalId) return byExternalId.id;

  if (/^\d+$/.test(String(repositoryId))) {
    const byPrimaryKey = db
      .prepare("SELECT id FROM repos WHERE id = ?")
      .get(Number(repositoryId));

    if (byPrimaryKey) return byPrimaryKey.id;
  }

  return null;
}

function getRepositoryGraph(repositoryId) {
  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return { nodes: [], edges: [] };

  const db = getDb();
  const files = db
    .prepare("SELECT id, path, language FROM files WHERE repo_id = ?")
    .all(repoId);
  const symbols = db
    .prepare(
      `SELECT s.id, s.file_id, s.name, s.kind, s.signature,
              s.line_start, s.line_end, s.is_exported
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE f.repo_id = ?`,
    )
    .all(repoId);
  const imports = db
    .prepare(
      `SELECT i.source_file_id, i.target_file_id, i.import_specifier, i.import_type
         FROM imports i
         JOIN files f ON f.id = i.source_file_id
        WHERE f.repo_id = ?`,
    )
    .all(repoId);

  return buildGraph({ files, symbols, imports });
}

module.exports = { buildGraph, getRepositoryGraph };
