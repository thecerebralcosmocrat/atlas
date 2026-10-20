# Atlas behavior test plan

This is the release gate for Atlas. It follows the principle that generated
code and a polished demo are not evidence: **a journey passes only when the
visible result and the persisted state agree**.

One row per journey, prioritized by the consequence of failure. The plan is
deliberately small. Add a row only when a new risk appears or a defect escapes.

## Scope

| Lane | Covered here | Notes |
|---|---|---|
| Functional end-to-end | Yes | Electron app from a clean install |
| Integration (IPC + SQLite + git + filesystem) | Yes | The primary automated lane |
| Security boundary (profile isolation) | Yes | Two-profile check, not a full ASVS review |
| Manual exploratory baseline | Yes | Run before automating a journey |
| Unit behavior | Existing suite | `npm test` already covers indexer/query helpers |
| Accessibility | Separate lane | axe + keyboard, not in this plan |
| Performance / load | Separate lane | Large repos, memory, index duration |
| Packaged installer | Separate lane | `npm run build` smoke on Windows |

## How Atlas maps onto the article

- **"Account" = profile.** Profiles are rows in `workspaces`; each repository
  carries `workspace_id` (`electron/db/schema.js:37`,
  `electron/db/repositories.js:31`). Profile switching is Atlas's authorization
  boundary.
- **"Refresh/restart" = relaunch Electron** with the same user-data directory.
- **"Backend state" = four places:** SQLite (`atlas.db`), the clone on disk,
  git refs inside the clone, and `settings.json`. A toast is never proof.
- **Test harness reality:** main-process tests run under Electron's Node with a
  fake `BrowserWindow` (`test/helpers/loadMain.js`). There is no renderer test
  layer yet; Phase 3 adds a thin Playwright Electron layer.
- **Fixtures are local:** temp user-data, `file://` git origins, no network.
  When the AI path matters, use a stub NIM server, never the real provider.

## Journey table

| # | Journey | Consequence of failure | Current coverage | Status |
|---|---|---|---|---|
| J1 | First run: add repository, clone, index, persist across relaunch | User sees nothing, or loses their repository on restart | `test/repositories-add.integration.test.js:13`; backfill `:218` | Partial — no relaunch assertion |
| J2 | Ask a grounded question without an API key | Core product promise fails offline; answers fabricate | `:259`, `:365`; retrieval/embedder tests | Partial — no renderer, no timeout path |
| J3 | Profile A cannot read or mutate profile B's repository | Cross-profile data exposure / destructive bug | Switching, restart, secret-leak tests in `test/profiles.integration.test.js` | **Fix implemented** (`findActiveRepository` in `electron/main.js`); `test/profile-isolation.integration.test.js` must pass before J3 is closed |
| J4 | Refresh pulls a remote commit and re-indexes; dirty clones are protected | Stale or corrupted code intelligence | `test/repositories-sync.integration.test.js` (7 cases) | Strong; add failure-state cases |
| J5 | Destructive actions affect only intended records | User's checkout deleted; profile data lost | `repositories-add.integration.test.js:292–385`; profile deletion tests | Strong; no renderer confirmation flow |
| J6 | Broken happy paths fail understandably and leave prior state intact | Half-written clone, stuck UI, silent data loss | Invalid URL, duplicate add, malformed legacy | Partial — clone failure, AI timeout, corrupt settings |

## Behavior contracts

Each contract is the specification for both the manual baseline and the
automated test. "Proof" means the assertion that counts. "Must not" is a
failure condition even if the happy path passes.

### J1 — First run: add, index, relaunch

**Action**

1. Start with a fresh user-data directory and no API key.
2. Add a local git fixture repository.
3. Wait for the add to complete.
4. Quit and relaunch with the same user-data directory.

**Proof**

| Layer | Assertion |
|---|---|
| UI | Progress moves through `clone` → `index`; the repository appears in the sidebar with a non-zero file count. |
| State | Exactly one `repos` row exists with the active profile's `workspace_id`, correct `external_id`, and `file_count > 0`. |
| Filesystem | The clone exists under `<userData>/atlas-data/repositories/<slug>-<timestamp>/` and contains the fixture's files. |
| Index | Files, symbols, and imports are queryable; asking a question retrieves fixture content. |
| Relaunch | With the same user-data, `repositories:list` returns the repository and the index answers without re-adding it. |
| Failure | Adding an unreachable URL produces an understandable error, no `repos` row, and no leftover clone directory. |

**Must not happen**

- A repository row exists before indexing succeeds.
- A failed clone or index leaves an orphan folder.
- A restart loses the repository or shows it without its index.
- A second concurrent add of the same URL creates a second clone.

**Existing coverage:** clone, index, progress, cleanup on index failure,
duplicate-add rejection, backfill. Missing: relaunch persistence, cleanup on
clone failure.

**Automation:** `test/repositories-add.integration.test.js` (extend) and
`test/e2e/add-and-persist.spec.js` (new). The relaunch assertion can reuse the
`launch(userData)` pattern in `test/profiles.integration.test.js`. The "no row
before indexing succeeds" check needs a mid-index assertion: use the
`indexerClass` injection in `loadMain` to pause indexing, count `repos` rows,
then release it.

### J2 — Ask with no API key

**Action**

1. With no `NVIDIA_NIM_API_KEY` configured, index a fixture containing a known
   function or comment.
2. Ask a question whose answer requires that file.

**Proof**

| Layer | Assertion |
|---|---|
| UI | The answer renders, is not an error state, and lets the user ask again. |
| Content | The answer names the fixture path (and line range where applicable) and quotes or paraphrases the indexed content. |
| Fallback | Without embeddings, lexical retrieval still returns the relevant chunk; the answer path never blocks on the network. |
| AI unavailable | A provider error or timeout falls back to the local answer instead of leaving "Thinking…" indefinitely. |
| Failure | An empty question is rejected with a readable message; an unknown repository is rejected. |
| Privacy | No resolved settings payload sent to the renderer contains the API key. |

**Must not happen**

- "Thinking…" persists forever on provider timeout (`CHAT_TIMEOUT_MS`,
  `electron/main.js:536`).
- A missing key disables indexing or asking.
- An answer claims a file was read when retrieval returned nothing.

**Existing coverage:** grounding, not-indexed notice, keyword retrieval, no key
in renderer payloads. Missing: chat timeout fallback, real renderer assertion.

**Automation:** extend `repositories-add.integration.test.js`; add
`test/e2e/ask-offline.spec.js`. `CHAT_TIMEOUT_MS` is a hard-coded 60 seconds,
so make it injectable (or stub `fetch` to abort) rather than waiting a minute
in the test.

### J3 — Profile isolation (the two-account check)

Profile A and profile B stand in for two accounts. Repositories are scoped in
SQLite but the IPC layer currently looks repositories up without a profile
check (`findRepository` at `electron/db/repositories.js:148`). Treat this table
as the expected contract; the first automated run is likely to fail and drive
the fix.

**Action**

1. In profile A, add and index a fixture repository. Record its repository ID
   and clone path.
2. Switch to profile B.
3. Through the IPC request path, attempt every ID-scoped operation with A's ID.
4. Switch back to A and verify A's repository and clone are unchanged.

**Proof**

| Operation | Expected under profile B |
|---|---|
| `repositories:list` | A's repository is absent. |
| `repositories:inspect` | Rejects with `Repository not found.` |
| `repositories:ask` | Rejects; no excerpt or content from A leaks into the answer. |
| `repositories:remove` | Rejects; A's row and clone still exist. |
| `repositories:sync` | Rejects; A's git ref and index are unchanged. |
| `repositories:discard-changes` | Rejects; A's local edits survive. |
| `repositories:move` | **Decided: profiles are isolated.** The channel does not exist; a repository stays in the profile it was added to. To have the same repository in two profiles, add it in both (each gets its own clone and index) and delete it from either. |
| `get-graph`, `get-start-here`, `get-impact`, `get-ownership` | Reject or return nothing for A's ID. |
| `get-repos` | **Removed.** It listed every profile's repositories and the renderer never used it. |
| Settings | B's settings contain B's values; A's API key never appears. |
| Profile deletion | Deleting B deletes B's repositories and their clones; nothing is moved to another profile; A's repository and clone are untouched. |

Then repeat the destructive subset from A against B's ID. Neither direction may
read or mutate the other's data.

**Must not happen**

- A "forbidden" or empty label while the handler still returned A's data or
  accepted the mutation.
- Profile switching leaves a stale repository visible in the sidebar.
- Deleting a profile adopts or exposes another profile's key.

**Existing coverage:** switching updates repositories and settings; restart
restores the active profile; no key crosses IPC. Missing: any cross-profile
request-path test.

**Automation:** `test/profile-isolation.integration.test.js` (written, see
below). The fix
belongs in `electron/main.js` behind one helper that checks
`repository.workspaceId === getActiveProfileId()` and is used by every
ID-scoped handler.

**Test status:** `test/profile-isolation.integration.test.js` runs under
`npm test`. It failed 8 of 10 before the fix (every ID-scoped handler accepted
the other profile's repository). The fix scopes those handlers through
`findActiveRepository`, removes `get-repos` and `repositories:move`, and makes
profile deletion delete its repositories. Close J3 only after a green run.

| Test | Contract row it covers |
|---|---|
| `repositories:list` shows only the active profile's repositories | `repositories:list`, stale sidebar after switching |
| Profile B cannot inspect or ask about A's repository | `repositories:inspect`, `repositories:ask` |
| Profile B cannot read A's graph, start-here, impact, or ownership data | `get-graph`, `get-start-here`, `get-impact`, `get-ownership` |
| Profile B cannot remove A's repository | `repositories:remove` (row and clone survive) |
| Profile B cannot sync A's repository | `repositories:sync` (clone HEAD unchanged after a remote push) |
| Profile B cannot discard A's local edits | `repositories:discard-changes` (uncommitted edit survives) |
| No channel moves a repository between profiles or lists all of them | `repositories:move` and `get-repos` do not exist |
| Profile A cannot read or change B's repository | Reverse direction: inspect, graph, sync, discard, remove |
| Profile A's API key never appears under B | Settings, including events sent to the renderer |
| Deleting B deletes only B's repositories and clones | Profile deletion |

Read-only channels (`get-graph` and friends) pass if they reject
or return nothing, but fail if the result mentions the other profile's file or
symbol. Mutating channels must reject with `Repository not found.` and leave
the owner's row, clone, git HEAD, and local edits unchanged.

### J4 — Refresh and conflict handling

**Action**

1. Clone and index a fixture repository.
2. Push a commit to the fixture origin.
3. Trigger `repositories:sync`.
4. Separately, create a tracked local edit in a clone and sync.

**Proof**

| Case | Assertion |
|---|---|
| Clean update | The new file/content is indexed, `commit_sha` matches the remote tip, and the UI reloads. |
| Rename | Removed paths disappear from the index; the new path is retrievable. |
| Dirty clone | Sync is held; the repository reports `dirty`; answers reflect the local edit after the one allowed re-index. |
| Discard | Explicit discard applies the remote update, clears `dirty`, and records the new tip. |
| Unmanaged checkout | A repository outside the managed clones folder is never fetched or reset. |
| Unreachable | Offline/remote failure returns `unreachable`, keeps the previous `commit_sha`, and does not corrupt the index. |
| Failed apply | A failed fetch/reset leaves the index and recorded commit unchanged for the next pass. |

**Must not happen**

- `reset --hard` on a clone with the user's tracked edits.
- The recorded commit moves before the new content is indexed.
- Two concurrent passes index the same repository twice.

**Existing coverage:** strong. Add the failed-apply and reload assertions.

**Automation:** extend `test/repositories-sync.integration.test.js`; add
`test/e2e/sync.spec.js`.

### J5 — Destructive actions and recovery

**Action**

1. Remove a managed repository; verify row, index, and clone.
2. Remove a repository pointing at an unmanaged checkout.
3. Delete a non-default active profile.
4. Attempt to delete the default profile.

**Proof**

| Case | Assertion |
|---|---|
| Managed remove | Row, files, symbols, imports, chunks, and clone folder are gone; the renderer is notified. |
| Unmanaged remove | Row is gone; the user's checkout still exists with its contents. |
| Active profile delete | The default profile becomes active; theme, sync policy, AI config, and sidebar switch together; the deleted profile's settings row and repositories are gone. |
| Inactive profile delete | The active profile is untouched; the target's repositories, indexes, and managed clones are deleted. Nothing is moved to another profile; an unmanaged checkout is left on disk. |
| Default profile delete | Rejected with a readable error; nothing changes. |
| Delete during backfill | A repository deleted while an index is in flight does not reappear. |

**Must not happen**

- Deleting a row and leaving a cloned folder behind (or vice versa for
  unmanaged checkouts).
- Deleting an active profile while settings or the sidebar still point at it.
- A deleted profile's encrypted key being inherited by another profile.
- A deleted profile's repositories appearing under another profile.

**Existing coverage:** strong. Missing: renderer confirmation flow and the
default-profile deletion assertion if not already covered.

**Automation:** extend the existing integration tests; add
`test/e2e/remove.spec.js`.

### J6 — Broken and interrupted paths

Run these variants against the critical journeys. The pass condition is a
defined behavior, not "something happened."

| Input / condition | Required behavior |
|---|---|
| Empty, whitespace, malformed, or path-like add input | Rejected before git runs; actionable message; no filesystem writes. |
| Same repository added twice concurrently | Second call rejects; one clone and one row. |
| Clone fails or times out | No row, no orphan folder, readable error. |
| Index fails or times out | Clone removed, no row; retry is possible. |
| Provider returns 4xx/5xx or times out | Local fallback answer; no stuck spinner; error logged, not leaked to the UI as raw JSON. |
| `settings.json` corrupt or absent | App starts with defaults; no crash; no secret exposure. |
| Legacy `repositories.json` malformed | App starts; no partial import. |
| Navigation away mid-request | The request completes or aborts cleanly; no crash on unmount. |
| Concurrent sync + remove | No resurrection of the deleted row; recorded state matches reality. |

**Existing coverage:** invalid URL, duplicate add, index-failure cleanup,
malformed legacy, delete-during-backfill. Missing: clone failure, provider
timeout, corrupt settings, navigation/interruption in the renderer.

## Clean-state manual baseline

Run this before automating any new journey and once per release. Use a
disposable user-data directory, no API key, and test-mode integrations.

- [ ] The journey completes from a clean install, not a developer's existing
      profile.
- [ ] State survives refresh, quit, and relaunch.
- [ ] A harmless interruption produces an understandable result.
- [ ] The app does not silently rely on stale cache, existing permissions, or
      leftover data.
- [ ] Every setup dependency is recorded so automation cannot pass because of
      hidden environment work.
- [ ] No real credentials, production data, or personal paths enter fixtures,
      screenshots, traces, or defect reports.

## Automation plan

### Sequencing and effort

Reviewed for feasibility: the plan is implementable with the existing harness
(`loadMain`, `makeGitFixtureRepo`, `waitFor`, `tempDirs`). Rough effort is
1 to 1.5 weeks; the main-process lane is a few days of that.

| Phase | Work | Effort | Risk |
|---|---|---|---|
| 1 | Write the J3 test, watch it fail, add one scoped lookup helper, fix every ID-scoped handler (about 10); remove `get-repos` and `repositories:move`; make profile deletion delete its repositories; run the full suite | ~1 day | Low |
| 2 | Fill the J1, J2, J4, J6 integration gaps (relaunch, clone failure, chat timeout, failed apply, corrupt settings) | 2–3 days | Low |
| 3a | Add the test-only `ATLAS_USER_DATA` override (it does not exist yet) and a Playwright `_electron.launch` smoke test | under 1 day | Medium: confirm Playwright works with Electron 41 and the Electron-ABI `better-sqlite3` before writing specs |
| 3b | Five E2E specs; add `aria-label`/`htmlFor` where selectors need them (only about 20 exist in `src` today) | 3–4 days | Medium |
| 4 | CI on `windows-latest` (native rebuild and Electron download add run time) | ~1 day | Medium |

Phase 1 changes many handlers at once. Existing tests may call handlers across
profiles, so expect some to need updating.

### Main-process integration (existing lane)

- Runs with `npm test` through Electron's Node for the `better-sqlite3` ABI.
- Use `loadMain` and `makeGitFixtureRepo`; each file gets temp user-data.
- Every meaningful step asserts an outcome; no fixed sleeps (`waitFor` only).
- New file: `test/profile-isolation.integration.test.js` (J3; must be green).
- Extend: add/relaunch, clone failure, chat timeout, sync failed-apply, corrupt
  settings.

### Renderer E2E (new, smallest useful suite)

- Playwright `_electron.launch`, `workers: 1`, `fullyParallel: false`.
- Build the renderer first (`npx vite build`) and launch non-dev so tests do
  not depend on a Vite server.
- Isolate each test with a temp user-data override (a test-only
  `ATLAS_USER_DATA` environment variable applied before `app.whenReady`).
- Local git fixtures; stub NIM server when the AI path is exercised.
- Five specs: `add-and-persist`, `ask-offline`, `profile-isolation`,
  `remove`, `sync`.
- Selectors by role/label. Add missing `aria-label`/`htmlFor` where required.
- On failure, keep a trace, screenshot, video, console log, and the relevant
  SQLite/git state snapshot.

### Harness self-checks

- Every test step has a pass/fail assertion.
- Fixtures start from a known state and are isolated per test.
- Tests assert outcomes, not button presence.
- Retries are enabled only with an explicit, documented reason.
- Another person can diagnose a failure from the attached evidence alone.

## CI and release gates

| Trigger | Runs |
|---|---|
| Pull request | `npm test`, `npx vite build`, E2E smoke |
| Merge to `main` | Same suite on the merged result |
| Release | Full E2E + manual baseline + separate accessibility/performance lane |
| Changes to shared components, validation, data shapes, profiles/auth, git sync, AI adapters, or generated config | Treat as a regression trigger; run the full suite |

Platform: `windows-latest` first, because native modules, path handling, and
file deletion behavior differ from POSIX. Add a second OS only when it is a
supported target.

Every failed result needs a disposition:

- **Fixed** — link the change.
- **Accepted** — owner and expiry date recorded.
- **Blocked** — prerequisite recorded.
- **False positive** — reason documented.

Permanently ignored failures weaken the value of a green dashboard.

## Known risks and open questions

1. **Cross-profile handler access is likely open today** (J3). Verify with the
   new test before changing code; then fix with one scoped lookup helper used
   by every ID-scoped handler.
2. **Repository IDs are generated as `<slug>-<Date.now()>`**
   (`electron/main.js:1149`). IDs are not secrets, but tests must not rely on
   them being unguessable.
3. **Renderer behavior is unverified by the current suite.** A green `npm test`
   does not prove the UI wires the IPC contract correctly.
4. **`NODE_ENV=development` loads `.env`/`.env.local`.** E2E must launch in a
   mode that does not read developer secrets, or must override every relevant
   environment variable explicitly.
5. **No CI exists yet** (`.github/` is absent). Until it does, this plan is a
   local gate, not a release gate.
6. **Profile deletion is destructive.** Deleting a profile deletes its
   repositories, indexes, and managed clones. The Settings confirmation says
   so; the renderer confirmation flow is not yet covered by a test.
7. **Same repository in two profiles** is two independent clones and indexes.
   The in-flight add guard is keyed by URL only, so adding one URL in two
   profiles at the same moment wrongly rejects the second.
8. **Playwright + Electron 41 is unproven here.** Run a launch smoke test
   before investing in the five specs. Playwright is not yet a dependency.
9. **Chat timeout is not injectable** (`CHAT_TIMEOUT_MS = 60 * 1000`), which
   makes the provider-timeout test slow unless it is made configurable or
   `fetch` is stubbed.

## Out of scope (tracked as separate lanes)

- Accessibility and keyboard-only operation.
- Performance with very large repositories and memory growth.
- Security review beyond the two-profile boundary: `safeStorage` fallback,
  `contextIsolation`/`nodeIntegration`, IPC input validation, clone URL
  handling. This includes `index-repo`, which takes an arbitrary `repoPath`
  from the renderer.
- Packaged installer and auto-update behavior.
