# ProjectAtlas Roadmap

ProjectAtlas is an Electron desktop app for onboarding into a codebase: point it
at a GitHub repository, it clones and indexes the source into SQLite, then
answers questions about the code.

## Guiding decisions

- **SQLite is the single source of truth** for repositories and indexed files.
  The legacy `repositories.json` is imported once on first launch and never read
  again.
- **Incremental, vertical slices.** Each increment is a small end-to-end change
  that leaves the app runnable, with automated tests and a manual check.
- **Modules stay injectable and testable.** `electron/db/schema.js` takes an
  explicit path, `FileTraverser` and `query/search.js` are pure, and
  `IndexerService` accepts an injected window.
- **Retrieval augments, it never gates.** RAG waited for the symbol graph to be
  stable (I7), because retrieval that ignores structure duplicates what the
  graph already answers cheaply; it then landed in I8 as an enhancement. A
  missing API key, an offline machine, or a repository indexed before chunking
  falls back to lexical ranking instead of failing the answer.
- **Embeddings live in SQLite, not a vector database.** Chunk vectors are
  Float32 BLOBs in the same database as the rest of the index, ranked by brute
  force. Thousands of chunks scan in tens of milliseconds, so a second store to
  keep in sync would buy nothing measurable.
- **Every phase ships a working product.** Phase 1 ends with an app that can
  onboard a repository and answer questions about it, Phase 2 with structural
  and semantic answers, Phase 3 with a generated explanation of where to start.
  A phase is only finished when all of its increments are in and the app runs.

## Phases at a glance

| Phase | Product at the end | Increments | State |
|---|---|---|---|
| 1 — Make the app functional | Add a repo, watch it index, browse files, ask grounded questions | I0–I6 | done |
| 2 — Code graph + RAG | Explore how files, symbols, and imports connect; retrieve answers by meaning, not keywords | I7–I8 | done |
| 3 — Onboarding intelligence | A generated "start here" path plus impact and ownership answers for an unfamiliar codebase | I9–I11 | done |

Phase 2 was never written down as its own section — the original draft deferred
"code graph + RAG" as Phase 3 while the chat-grounding work (I5) and add/index
robustness (I6) landed inside Phase 1. This restructure closes that numbering
gap: the graph and RAG work becomes Phase 2, and the next product becomes
Phase 3.

## Phase 1 — Make the app functional

| # | Increment | State |
|---|---|---|
| I0 | Test harness + schema/traverser tests | done |
| I1 | Idempotent, transactional indexing | done |
| I2 | Progress correctness + UI guards | done |
| I3 | Wire indexer into add flow + DB init | done |
| I4 | Serve repo list from SQLite (+ migrate JSON) | done (`abd8f98`) |
| I5 | Ground chat answers in indexed files | done |
| I6 | Robustness (URL validation, orphan cleanup, timeouts) | done |

I5 and I6 stay in Phase 1 rather than moving to Phase 2. Phase 1's product is an
app that ends in a trustworthy answer: I5 is what makes chat cite real indexed
files instead of guessing, and I6 is what keeps a failed clone or index from
leaving a repository row pointing at nothing. Phase 2 starts from that
trustworthy index and adds structure (I7) and retrieval by meaning (I8).

### I5 — Ground chat answers in indexed files

`repositories:ask` retrieves the most relevant indexed files for the question
and grounds both the NVIDIA NIM answer and the offline keyword fallback in their
contents, citing file paths and line ranges. A repository with nothing indexed
gets an explicit "not been indexed yet" answer instead of a guess.

- Retrieval: `electron/query/search.js` — lexical ranking (`rankFiles`) plus a
  SQLite-backed lookup (`searchRepositoryFiles`). The lookup resolves the
  renderer's external id first and only falls back to the numeric primary key
  when nothing matches, so the two can never union in another repo's files.
- Wiring: `electron/main.js` (`buildRepositoryContext`,
  `answerRepositoryQuestion`, the `repositories:ask` handler).
- Tests: `test/search.test.js`, plus ask integration tests in
  `test/repositories-add.integration.test.js`.

### I6 — Robustness

- URL validation: `validateRepositoryUrl` rejects blank and non-URL input before
  any filesystem work, so a bad paste cannot create a clone target.
- Orphan cleanup: the `repositories:add` clone+index sequence is wrapped in a
  try/catch that removes the clone folder on failure, and the repository row is
  written by the indexer, so a failed index leaves neither files nor a DB row.
  Progress notifications go through `notifyProgress`, which swallows a throw
  from a destroyed window: a courtesy message must never fail an index that has
  already committed, or the folder would be deleted while the row survived.
- Timeouts: clone uses `simple-git`'s `timeout.block`; indexing takes a
  `deadline` checked between files and before the synchronous write transaction,
  so a timed-out index commits nothing. Both are wired into `repositories:add`,
  `index-repo`, and the startup backfill.
- The cited line range is trimmed when an excerpt is truncated at
  `maxExcerptChars`, so it never names lines the reader cannot see.
- Tests no longer leak `atlas-*` temp directories: `test/helpers/tempDirs.js`
  tracks every `makeTempDir` and removes it in a `test.after` hook, clearing
  SQLite's file lock and git's read-only packfiles first (both block removal on
  Windows). `npm test` now targets `test/*.test.js` explicitly so helper files
  under `test/` are not executed as tests.

## Phase 2 — Code graph + RAG

| # | Increment | State |
|---|---|---|
| I7 | Symbol graph | done |
| I8 | Embeddings + retrieval-augmented answers | done |

### I7 — Symbol graph

The indexer extracts symbols and imports per file while indexing and stores them
in the `symbols` and `imports` tables, resolving relative imports to a
`target_file_id` (bare specifiers are recorded as external). `get-graph` returns
the file/symbol/import graph and the Explorer renders it.

- Extraction: `electron/indexer/SymbolExtractor.js` is a per-language dispatch
  table (JS/TS/JSX/TSX and Python) returning one shared record shape. It is
  heuristic rather than a parser, so tree-sitter can replace a single entry
  later without the indexer or the query layer changing. A language with no
  extractor returns empty results, never an index failure.
- Resolution: `electron/indexer/ImportResolver.js` handles relative JS/TS
  (extension and `/index.*` inference, and a `.js` specifier onto a `.ts` file)
  and Python dotted relative imports (leading dots, `__init__.py`). Anything it
  cannot map onto an indexed path stays external.
- Indexing: `electron/indexer/IndexerService.js` extracts while reading — before
  the synchronous write transaction — then inserts files, symbols, and imports
  as one transaction, so a re-index replaces the previous graph wholesale.
- Graph query: `electron/query/graph.js` — pure `buildGraph` plus the DB-backed
  `getRepositoryGraph`. Nodes are files, symbols, and external packages; edges
  are `contains` (file → symbol) and `imports` (file → file/external). The
  repository id resolves the external id first with a numeric fallback,
  mirroring `query/search.js`.
- IPC and UI: `electron/main.js` (`get-graph`), `electron/preload.js`
  (`graph.get`), and `src/App.jsx` (`CodeGraphPanel` in the Explorer: expand a
  file to see its symbols, outgoing imports, and incoming imports).
- Tests: `test/SymbolExtractor.test.js`, `test/ImportResolver.test.js`,
  `test/graph.test.js`, plus symbol/import coverage in
  `test/IndexerService.test.js`.

### I8 — Embeddings + retrieval-augmented answers

`repositories:ask` now retrieves by meaning: files are chunked while indexing,
each chunk is embedded through NVIDIA NIM and stored as a Float32 BLOB, and a
question is answered from the chunks whose vectors are closest to it. Retrieval
is an enhancement, so the lexical ranking from I5 still answers when there are no
vectors to compare against.

- Chunking: `electron/pipeline/chunker.js` — pure line-window chunking
  (`chunkFile`) with a character ceiling and a line overlap, so a symbol on a
  window boundary still appears whole in one chunk. Nothing is cut mid-line, so
  a chunk's start/end line always maps onto lines that exist and can be cited.
- Embedding: `electron/pipeline/embedder.js` — `createNimEmbedder` batches
  through NIM's OpenAI-compatible `/embeddings` endpoint and labels each side
  (`input_type: "passage"` while indexing, `"query"` for a question), because
  these models are asymmetric and the same text lands in a different place as a
  query. It returns null without a key, takes an injectable `fetchImpl` so tests
  never hit the network, and rejects any response it cannot line up with its
  input: a short one would shift every later vector onto the wrong chunk, and a
  full-length one whose items carry no vector, or carry entries that are not
  finite numbers, would be stored as `undefined` or a BLOB of NaNs and only
  fail later — inside the indexer's write transaction for the missing vector,
  and never at all for the NaNs, which spend storage on a vector no score can
  ever be computed from.
- Storage and scoring: `electron/query/vectors.js` — `encodeVector`/
  `decodeVector` for the BLOB (copying the bytes out first, since SQLite can
  hand back a Buffer at any offset and a `Float32Array` view needs 4-byte
  alignment) plus a computed cosine similarity that scores a dimension mismatch
  as 0 rather than guessing. The `chunks` table is created by
  `electron/db/schema.js`, and candidates are filtered by `model`: a chunk left
  behind by a model that is no longer configured lives in a different vector
  space, where a similarity score would be meaningless.
- Retrieval: `electron/query/search.js` — `rankChunks` keeps the best chunk per
  file and applies the excerpt budget, dropping any chunk whose score is not
  positive. That test is written as "not greater than zero" rather than "less
  than or equal to zero" so a stored vector of non-numbers, which scores NaN, is
  dropped too: a repository whose vectors are all unusable then falls through to
  the lexical pass instead of being answered from scores nothing can be ordered
  by. `semanticSearch` streams candidates with
  SQLite's `iterate` so a large repository is ranked one row at a time (closing
  the iterator in a `finally` so a corrupt BLOB cannot wedge the connection),
  and `retrieveRepositoryExcerpts` prefers chunks and falls back to
  `searchRepositoryFiles`. Both paths cite excerpts through one `clipExcerpt`,
  so a semantic and a lexical excerpt trim identically.
- Indexing: `electron/indexer/IndexerService.js` chunks and embeds after the
  file reads and before the synchronous write transaction, because embedding is
  a network round trip and better-sqlite3 transactions must stay synchronous.
  Embedding failure is all-or-nothing per repository and non-fatal: a
  half-embedded index would answer some questions semantically and silently fall
  back for others, which reads as a retrieval bug rather than a missing API call.
  A response with the wrong number of vectors counts as a failure too, because a
  short one would shift every later vector onto the wrong chunk.
- Migration: `listRepositoriesWithoutChunks` (`electron/db/repositories.js`)
  finds repositories indexed before chunking existed, and the startup backfill
  re-indexes them once an embedder is configured — without a key it would
  re-read every repository on every launch to produce no chunks at all. The
  query is scoped to the configured model, so a repository whose chunks came
  from a model that is no longer configured is embedded again rather than
  counted as done, and a repository whose last index found no files is
  excluded. A repository with files that produced no chunks is retried on the
  next launch: an embed that failed should be retried, and one with nothing
  worth chunking costs a re-read and no request.
- Wiring: `electron/main.js` — `getNimEmbedder` (built per use, and null
  without a key) is passed to all three `indexRepo` call sites and to the
  `repositories:ask` handler. The dead `query-rag` stub is gone; the question
  path was already `repositories:ask`.
- LanceDB is left in `package.json` but unused. Vectors live in SQLite with the
  rest of the index, which is the single source of truth, so there is no second
  store to keep in sync.
- Tests: `test/chunker.test.js`, `test/vectors.test.js`,
  `test/embedder.test.js`, `test/retrieval.test.js`,
  `test/IndexerService.chunks.test.js`, and the chunk-backfill cases in
  `test/repositories.test.js`.

## Phase 3 — Onboarding intelligence

Phase 3 turns the index and graph from something you query into something that
explains the codebase for you. Each increment is an answer a new hire would
otherwise have to assemble by hand, and none of them need a new dependency.

| # | Increment | State |
|---|---|---|
| I9 | Entry points + a guided "start here" path | done |
| I10 | Impact analysis from the import graph | done |
| I11 | Ownership and recency from git history | done |

### I9 — Entry points + "start here"

Where execution begins is detected from `package.json` `main`/`bin`, conventional
entry basenames (`index`/`main`/`app`/`server`/`cli`, Python `__main__.py`), and
Python `if __name__ == "__main__"` guards. The modules worth reading next are
ranked by fan-in from the I7 import graph — how many distinct non-test files
import a module — and the two are merged into one ordered reading path, rendered
in the Explorer above the code graph.

- Detection and ranking: `electron/query/entrypoints.js` — pure
  `detectEntryPoints` and `buildStartHere`, plus the DB-backed `getStartHere`.
  Entry points are deduped by first-match priority (package.json beats a
  conventional basename), capped so a tree full of `index.*` files cannot fill
  the list, and tested in `test/entrypoints.test.js`.
- Path resolution: a `main`/`bin` written as Node resolves it (no extension, or
  a directory meaning its `index.*`) is matched against the indexed paths, so a
  `main` pointing at a skipped `dist/` resolves to nothing rather than a phantom
  entry. Paths are normalized with the indexer's `toPosix`, because Windows
  stores backslashes.
- Fan-in and test exclusion: `buildStartHere` counts distinct importers per file
  from `getRepositoryGraph`'s edges, ignoring external packages and test
  importers, and drops test files from the ranking itself. Reads only a
  `hasMainGuard` flag per file (`instr(raw_content, '__main__')`), so it does not
  pull every file body into memory.
- package.json: not an indexed extension, so `getStartHere` reads it from the
  clone's root path and tolerates a missing or malformed file.
- Ids: `findRepoPrimaryKey` is now exported from `electron/query/graph.js` and
  reused here, so both queries resolve the renderer's external id the same way.
- IPC and UI: `electron/main.js` (`get-start-here`), `electron/preload.js`
  (`graph.startHere`), and `src/App.jsx` (`StartHerePanel`).

### I10 — Impact analysis

The reverse of I7's edges: what imports a file, what a change can reach
transitively, where a symbol is defined and referenced, and which files no entry
point can reach.

- Query module: `electron/query/impact.js` — pure `fileImpact` (direct importers
  plus a breadth-first walk backwards over the import edges for the blast
  radius), `findUnreachableFiles` (breadth-first forwards from the I9 entry
  points), `findSymbolDefinitions`/`findSymbolReferences`, and
  `answerGraphQuestion` (turns an impact, usage, or unreachability question into
  a grounded answer), plus the DB-backed `getImpact` and
  `answerRepositoryGraphQuestion`.
- Targets: `resolveGraphTarget` prefers a full path named in the question, then
  a basename, then a symbol name, so "who imports src/util.js" resolves the file
  while "who uses formatDate" resolves the symbol. When nothing in the index is
  named, the question falls through to lexical retrieval and the model, so the
  graph never guesses an answer.
- Reachability: entry points come from `detectEntryPoints`, and test files are
  excluded from the unreachable list. A repository with no entry points reports
  nothing rather than marking every file dead.
- Symbol usage: definitions are exact matches from `symbols`; references are a
  word-boundary scan of indexed contents that skips a definition's own line
  range, because the graph records definitions but not reference edges yet.
- IPC and UI: `electron/main.js` (`get-impact`, and grounding
  `repositories:ask` in the graph before NIM), `electron/preload.js`
  (`graph.impact`), and `src/App.jsx` (`ImpactPanel`: pick a file to see its
  direct importers and blast radius, plus the repository-wide unreachable list).
- Tests: `test/impact.test.js`.

### I11 — Ownership and recency

Every indexed file is annotated from the clone's `git log` with how often it
changed, when it last changed, and who touched it most — churn hotspots, recent
changes, and likely reviewers per file — so "who should I ask?" has an answer
grounded in the history the app already cloned.

- Query module: `electron/query/ownership.js` — pure `parseGitLog`,
  `buildOwnership`, `detectOwnershipIntent`, and `answerOwnershipQuestion`,
  plus the git-backed `readGitHistory`, `getOwnership`, and
  `answerRepositoryOwnershipQuestion`.
- History depth: the app clones with `--depth 1`, so the first ownership read
  deepens the clone by a bounded 200 commits (`git fetch --deepen`), once per
  clone per process. A failed fetch (offline, no remote) keeps whatever history
  is present rather than erroring, and a clone that is still shallow says so in
  the answer instead of implying it is complete.
- Ranking: per file, the commit count, last change, and authors ordered by
  commits (the likely reviewers); repository-wide, churn hotspots, recent
  changes, and contributors with their commit and distinct indexed-file counts.
  Test paths are left out of the hotspot and recent rankings so they do not
  crowd out application code, and a contributor whose commits only touch
  unindexed files (docs) still counts as a commit.
- Targets: reuses `resolveGraphTarget` from `query/impact.js`, so a question
  that names a file resolves the file and a question about the repository as a
  whole falls back to the contributor ranking.
- IPC and UI: `electron/main.js` (`get-ownership`, and answering ownership and
  recency in `repositories:ask` before NIM), `electron/preload.js`
  (`graph.ownership`), and `src/App.jsx` (`OwnershipPanel`: pick a file for its
  likely reviewers, plus the repository's churn hotspots, recent changes, and
  top contributors).
- Tests: `test/ownership.test.js`, including a shallow clone deepened end to
  end from a local origin.

## Testing

`better-sqlite3` is compiled for the Electron ABI, so plain `node --test` cannot
load it. Run everything through the Electron runtime:

```bash
npm test        # cross-env ELECTRON_RUN_AS_NODE=1 electron --test "test/*.test.js"
```

Other useful commands:

```bash
npx vite build      # renderer build
npm run dev         # run the app (Vite + Electron)
npm run db:stats    # inspect the SQLite index
```
