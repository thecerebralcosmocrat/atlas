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
- **Phase 3 (code graph + RAG) is deferred** until Phase 1 is stable, because
  both depend on an index that actually exists and is correct.

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

## Phase 3 — Code graph + RAG (deferred)

`get-graph` and `query-rag` IPC handlers are still stubs. Planned work:
tree-sitter symbol extraction (the `pipeline/*` modules are empty, but the
`symbols` and `imports` tables already exist), LanceDB embeddings, and
retrieval-augmented answers. Depends on Phase 1 being stable.

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
