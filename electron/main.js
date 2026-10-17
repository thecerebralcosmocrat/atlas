const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const simpleGit = require("simple-git");
const { initializeDatabase, ensureDefaultWorkspace } = require("./db/schema");
const {
  listRepositories,
  listUnindexedRepositories,
  listRepositoriesWithoutChunks,
  listSyncableRepositories,
  findRepository,
  deleteRepository,
  setRepositorySyncState,
  legacyRepositoriesImported,
  importLegacyRepositories,
} = require("./db/repositories");
const {
  listWorkspaces,
  findWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  moveRepositoryToWorkspace,
} = require("./db/workspaces");
const { IndexerService } = require("./indexer/IndexerService");
const {
  inspectRepositoryUpdate,
  applyRepositoryUpdate,
} = require("./sync/gitSync");
const { retrieveRepositoryExcerpts } = require("./query/search");
const { createNimEmbedder } = require("./pipeline/embedder");
const { getRepositoryGraph } = require("./query/graph");
const { getStartHere } = require("./query/entrypoints");
const {
  answerRepositoryGraphQuestion,
  getImpact,
} = require("./query/impact");
const {
  answerRepositoryOwnershipQuestion,
  getOwnership,
} = require("./query/ownership");
const {
  initializeSettings,
  getPublicSettings,
  getResolvedSettings,
  updateSettings,
} = require("./settings");

const isDev = process.env.NODE_ENV === "development";

// Embeddings use the same NIM account as the answers. Built per use rather than
// cached so a change in Settings — or an environment file loaded later — takes
// effect without a restart. It returns null without a key: semantic retrieval
// is an enhancement, so a missing key must not stop indexing or answering
// questions.
function getNimEmbedder() {
  const { ai } = getResolvedSettings();

  return createNimEmbedder({
    apiKey: ai.apiKey,
    model: ai.embedModel,
    apiUrl: ai.embedApiUrl,
  });
}
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "node_modules",
  "out",
  "build",
  ".next",
]);
const README_CANDIDATES = ["README.md", "readme.md", "README", "Readme.md"];

async function loadLocalEnv() {
  if (!isDev) return;

  const envPaths = [
    path.join(__dirname, "../.env"),
    path.join(__dirname, "../.env.local"),
  ];

  for (const envPath of envPaths) {
    const contents = await readOptionalText(envPath, 10000);

    if (!contents) continue;

    for (const line of contents.split("\n")) {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) continue;

      const separatorIndex = trimmedLine.indexOf("=");

      if (separatorIndex === -1) continue;

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");

      if (key) {
        process.env[key] = value;
      }
    }
  }
}

function getAtlasPaths() {
  const atlasRoot = path.join(app.getPath("userData"), "atlas-data");

  return {
    atlasRoot,
    repositoriesRoot: path.join(atlasRoot, "repositories"),
    storePath: path.join(atlasRoot, "repositories.json"),
  };
}

// The settings file can outlive the database row it points at (the workspace
// was deleted, or the index was rebuilt). Verify the selection on every read
// and fall back to the default workspace rather than showing an empty sidebar
// until the user changes something. listWorkspaces puts the default first.
function getActiveWorkspaceId() {
  const configuredId = getResolvedSettings().general.activeWorkspaceId;

  if (configuredId !== null && findWorkspace(configuredId)) {
    return configuredId;
  }

  return listWorkspaces()[0]?.id ?? null;
}

function notifyWorkspacesChanged(event) {
  BrowserWindow.fromWebContents(event.sender)?.webContents?.send(
    "workspaces:changed",
  );
}

async function ensureAtlasStorage() {
  const { atlasRoot, repositoriesRoot } = getAtlasPaths();

  await fs.mkdir(repositoriesRoot, { recursive: true });

  return { atlasRoot, repositoriesRoot };
}

// True only for a path inside the folder the app clones into. Imports and legacy
// rows can point at a checkout the user already had, and Atlas must never
// delete or rewrite one of those.
function isManagedRepositoryPath(localPath) {
  if (!localPath) return false;

  const { repositoriesRoot } = getAtlasPaths();
  const clonePath = path.resolve(localPath);
  const managedRoot = path.resolve(repositoriesRoot) + path.sep;

  return clonePath.startsWith(managedRoot);
}

async function readLegacyRepositories() {
  const { storePath } = getAtlasPaths();

  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Moves the pre-SQLite repositories.json store into the database exactly once.
async function migrateLegacyRepositories() {
  if (legacyRepositoriesImported()) return;

  try {
    const legacyRepositories = await readLegacyRepositories();

    if (legacyRepositories.length === 0) return;

    importLegacyRepositories(legacyRepositories);
  } catch (error) {
    // A malformed legacy file must never stop the app from starting; the
    // import transaction rolls back, so the database is left untouched.
    console.error("Failed to import legacy repositories.json:", error);
  }
}

// Paths the user deleted while the startup backfill was still running. The
// backfill picks its targets once, and the indexer upserts the repository row,
// so a deletion landing mid-backfill would otherwise be undone when the
// in-flight index commits: the repository would reappear in the sidebar, now
// pointing at a folder that has already been removed.
const deletedRepositoryPaths = new Set();

function markRepositoryDeleted(localPath) {
  deletedRepositoryPaths.add(path.resolve(localPath));
}

function wasRepositoryDeleted(localPath) {
  return deletedRepositoryPaths.has(path.resolve(localPath));
}

// Indexes repositories that were recorded without an index (legacy imports, or
// rows written before indexing existed), then re-indexes any repository that
// predates chunking so it can be answered semantically. Runs after the window
// opens so it never delays startup, and the renderer refreshes once it finishes.
async function backfillRepositoryIndexes(mainWindow) {
  const embedder = getNimEmbedder();
  // Both passes re-index an existing row in place, so they share one loop. The
  // chunk pass only runs with an embedder: without a key it would re-read every
  // repository on every launch to produce no chunks at all. It is scoped to the
  // configured model, so chunks from a model that is no longer configured do
  // not mask a repository that still needs vectors in the current one.
  const targets = [
    ...listUnindexedRepositories(),
    ...(embedder ? listRepositoriesWithoutChunks(embedder.model) : []),
  ];

  for (const repository of targets) {
    if (wasRepositoryDeleted(repository.localPath)) continue;

    try {
      await fs.access(repository.localPath);
    } catch {
      console.warn(
        `Skipping index backfill; folder not found: ${repository.localPath}`,
      );
      continue;
    }

    try {
      await new IndexerService().indexRepo(
        repository.localPath,
        mainWindow,
        {
          externalId: repository.externalId,
          name: repository.name,
          url: repository.url,
          addedAt: repository.addedAt,
          workspaceId: repository.workspaceId,
        },
        { timeoutMs: INDEX_TIMEOUT_MS, embedder },
      );
    } catch (error) {
      console.error(`Failed to index ${repository.name}:`, error);
    }

    // The index rewrites the repository row as part of indexing. A deletion
    // that arrived while this one was in flight has just been overwritten, so
    // remove it again rather than handing the user back a repository they
    // deleted. Both are synchronous transactions on one connection, so the
    // index and the delete cannot interleave — only one can be last.
    if (wasRepositoryDeleted(repository.localPath)) {
      deleteRepository(repository.id);
    }
  }

  mainWindow?.webContents?.send("repositories:changed");
}

// Returning to the window is the moment a user is most likely looking for fresh
// data, so a focus check is allowed — but no more often than this, or alt-tabbing
// would hammer the remote. The periodic interval itself is a setting; the check
// is a `git ls-remote`, which transfers no objects, so a short interval costs
// almost nothing and only a repository that actually moved is fetched.
const SYNC_MIN_GAP_MS = 30 * 1000;

// Re-indexes a repository whose working tree just moved, either onto the remote
// tip or (for a dirty clone) to reflect the user's local edits. Returns false
// when the repository was deleted while the index was in flight: the index
// rewrote the row on its way out, so the caller must not record sync state for
// a repository that no longer exists.
async function reindexSyncedRepository(repository, mainWindow) {
  await new IndexerService().indexRepo(
    repository.localPath,
    mainWindow,
    {
      externalId: repository.externalId,
      name: repository.name,
      url: repository.url,
      addedAt: repository.addedAt,
      workspaceId: repository.workspaceId,
    },
    { timeoutMs: INDEX_TIMEOUT_MS, embedder: getNimEmbedder() },
  );

  if (wasRepositoryDeleted(repository.localPath)) {
    deleteRepository(repository.id);
    return false;
  }

  return true;
}

// Brings one cloned repository level with its remote. Nothing is fetched until
// the remote tip is known to differ from what was indexed, and a clone with
// tracked local edits is left alone rather than reset — those edits are the
// user's work, and `reset --hard` would discard them without asking.
async function syncRepository(repository, mainWindow) {
  const skipped = { id: repository.id, status: "skipped", changed: false };

  // Only clones Atlas made are updated. A legacy row can point at the user's own
  // checkout, and moving that working tree is not Atlas's call to make.
  if (
    !repository.url ||
    !isManagedRepositoryPath(repository.localPath) ||
    wasRepositoryDeleted(repository.localPath)
  ) {
    return skipped;
  }

  let update;

  try {
    update = await inspectRepositoryUpdate({
      localPath: repository.localPath,
      url: repository.url,
      commitSha: repository.commitSha,
    });
  } catch (error) {
    // Offline, deleted remote, or no credentials: leave the index alone and try
    // again next pass rather than trading a working repository for an error.
    console.warn(`Could not check ${repository.name} for updates:`, error.message);
    return { id: repository.id, status: "unreachable", changed: false };
  }

  if (update.status === "unchanged") {
    return { id: repository.id, status: "unchanged", changed: false };
  }

  if (update.status === "dirty") {
    // Local edits are holding the update back. Index the tree as it stands once
    // so answers reflect the edits, and remember the repository is behind. A
    // repository already known to be dirty is left alone instead of re-indexed
    // on every pass.
    if (repository.syncState === "dirty") {
      return { id: repository.id, status: "dirty", changed: false };
    }

    const indexed = await reindexSyncedRepository(repository, mainWindow);

    if (indexed) {
      setRepositorySyncState(repository.id, {
        commitSha: update.baselineSha,
        syncState: "dirty",
      });
    }

    return { id: repository.id, status: "dirty", changed: indexed };
  }

  // update-available: the working tree carries no tracked changes, so it is safe
  // to fast-forward onto the remote tip. A failed update leaves the recorded
  // commit untouched, so the next pass simply tries again.
  let applied;

  try {
    applied = await applyRepositoryUpdate(
      { localPath: repository.localPath, url: repository.url },
      { branch: update.branch },
    );
  } catch (error) {
    console.warn(`Could not update ${repository.name}:`, error.message);
    return { id: repository.id, status: "unreachable", changed: false };
  }

  const indexed = await reindexSyncedRepository(repository, mainWindow);

  if (indexed) {
    // The recorded commit moves only after the new content is indexed, so a
    // failed index is retried on the next pass rather than silently skipped.
    setRepositorySyncState(repository.id, { commitSha: applied, syncState: null });
  }

  return { id: repository.id, status: "updated", changed: indexed };
}

// One pass over every repository that came from a remote and has been indexed at
// least once. A pass already running is shared rather than started again: the
// timer and a window focus can land together, and two passes would index the
// same repository twice.
let syncInFlight = null;

async function syncAllRepositories(mainWindow) {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const results = [];

    for (const repository of listSyncableRepositories()) {
      try {
        results.push(await syncRepository(repository, mainWindow));
      } catch (error) {
        console.error(`Failed to sync ${repository.name}:`, error);
        results.push({ id: repository.id, status: "failed", changed: false });
      }
    }

    return results;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

function summarizeSync(results) {
  const count = (status) =>
    results.filter((result) => result.status === status).length;

  return {
    checked: results.length,
    updated: count("updated"),
    dirty: count("dirty"),
    unreachable: count("unreachable"),
  };
}

let syncTimer = null;
let syncWindow = null;
// Zero rather than "now" so the first focus — the window opening — runs a pass,
// which is what picks up commits pushed while Atlas was closed.
let lastSyncAt = 0;

function runSyncPass() {
  lastSyncAt = Date.now();

  syncAllRepositories(syncWindow)
    .then((results) => {
      if (results.some((result) => result.changed)) {
        syncWindow?.webContents?.send("repositories:changed");
      }
    })
    .catch((error) => console.error("Repository sync failed:", error));
}

// Re-reads the auto-sync setting and replaces the timer. Called on launch and
// whenever Settings changes, so turning sync off (or shortening the interval)
// takes effect without a restart.
function scheduleSyncPolling() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;

  if (!syncWindow) return;

  const { autoSync, syncIntervalMinutes } = getResolvedSettings().general;

  if (!autoSync) return;

  syncTimer = setInterval(runSyncPass, syncIntervalMinutes * 60 * 1000);
  // The poller is a convenience, not a reason for the process to stay alive.
  syncTimer.unref?.();
}

// Starts the background checks. A pass is not run here directly: the timer and
// the window focus both call one, and the opening focus covers startup without
// making launch wait on the network.
function startSyncPoller(mainWindow) {
  syncWindow = mainWindow;

  mainWindow?.on?.("focus", () => {
    if (!getResolvedSettings().general.autoSync) return;
    if (Date.now() - lastSyncAt < SYNC_MIN_GAP_MS) return;
    runSyncPass();
  });

  mainWindow?.on?.("closed", () => {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    syncWindow = null;
  });

  scheduleSyncPolling();
}

// Brings one repository level with its remote even though it has local edits,
// which is the explicit "discard and sync" the UI offers. Unlike the poller this
// is the user's decision, so the local changes are discarded on purpose.
async function discardRepositoryChanges(repository, mainWindow) {
  if (!repository.url || !isManagedRepositoryPath(repository.localPath)) {
    throw new Error("Only repositories Atlas cloned can be updated.");
  }

  const update = await inspectRepositoryUpdate({
    localPath: repository.localPath,
    url: repository.url,
    commitSha: repository.commitSha,
  });
  const applied = await applyRepositoryUpdate(
    { localPath: repository.localPath, url: repository.url },
    { branch: update.branch },
  );
  const indexed = await reindexSyncedRepository(repository, mainWindow);

  if (indexed) {
    setRepositorySyncState(repository.id, { commitSha: applied, syncState: null });
  }

  return applied;
}

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
// A chat request that never answers must not hold the ask handler open, or the
// renderer sits on "Thinking…" forever. Past this it falls back to the local
// answer path.
const CHAT_TIMEOUT_MS = 60 * 1000;
const CLONE_URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const CLONE_SCP_LIKE = /^[^\s/@]+@[^\s/:]+:[^\s]+$/;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const INVALID_URL_MESSAGE =
  "Enter a valid repository URL (for example https://github.com/owner/repo.git).";

// Rejects obviously unusable input with an actionable message before we spawn
// git, so the user sees why the add failed instead of a raw clone error.
function validateRepositoryUrl(repositoryUrl) {
  if (!repositoryUrl || typeof repositoryUrl !== "string") {
    throw new Error("Enter a repository URL.");
  }

  const trimmedUrl = repositoryUrl.trim();

  if (!trimmedUrl || /\s/.test(trimmedUrl)) {
    throw new Error(INVALID_URL_MESSAGE);
  }

  const looksLikePath =
    CLONE_URL_SCHEME.test(trimmedUrl) ||
    CLONE_SCP_LIKE.test(trimmedUrl) ||
    WINDOWS_ABSOLUTE_PATH.test(trimmedUrl) ||
    trimmedUrl.startsWith("/") ||
    trimmedUrl.startsWith("./") ||
    trimmedUrl.startsWith("../") ||
    trimmedUrl.startsWith("\\\\") ||
    trimmedUrl.startsWith("~");

  if (!looksLikePath) {
    throw new Error(INVALID_URL_MESSAGE);
  }

  return trimmedUrl;
}

function getRepositoryName(repositoryUrl) {
  const cleanedUrl = repositoryUrl.trim().replace(/\/$/, "");
  const lastSegment = cleanedUrl.split("/").pop() || "repository";

  return lastSegment.replace(/\.git$/, "") || "repository";
}

function getRepositorySlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function getDirectorySummary(directoryPath, depth = 0) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  const children = [];
  let fileCount = 0;
  let directoryCount = 0;

  for (const entry of visibleEntries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      directoryCount += 1;
      const childSummary = await getDirectorySummary(entryPath, depth + 1);

      fileCount += childSummary.fileCount;
      directoryCount += childSummary.directoryCount;

      children.push({
        name: entry.name,
        type: "directory",
        children: depth < 2 ? childSummary.children : [],
      });
    } else {
      fileCount += 1;
      children.push({
        name: entry.name,
        type: "file",
      });
    }
  }

  return { children, fileCount, directoryCount };
}

async function inspectRepository(repository) {
  const summary = await getDirectorySummary(repository.localPath);

  return {
    ...repository,
    // The database is the source of truth for what was actually indexed; the
    // filesystem walk only adds the folder count and browsing tree.
    fileCount: repository.fileCount ?? summary.fileCount,
    directoryCount: summary.directoryCount,
    tree: summary.children,
  };
}

async function readOptionalText(filePath, maxLength = 6000) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return contents.slice(0, maxLength);
  } catch {
    return "";
  }
}

async function readRepositoryReadme(localPath) {
  for (const fileName of README_CANDIDATES) {
    const contents = await readOptionalText(path.join(localPath, fileName));

    if (contents) return contents;
  }

  return "";
}

function getTopLevelNames(tree = [], type) {
  return tree
    .filter((item) => item.type === type)
    .slice(0, 10)
    .map((item) => item.name);
}

function summarizePackageJson(packageJsonText) {
  if (!packageJsonText) return null;

  try {
    const packageJson = JSON.parse(packageJsonText);

    return {
      name: packageJson.name,
      description: packageJson.description,
      scripts: packageJson.scripts || {},
      dependencies: Object.keys(packageJson.dependencies || {}),
      devDependencies: Object.keys(packageJson.devDependencies || {}),
    };
  } catch {
    return null;
  }
}

function firstReadmeParagraph(readme) {
  if (!readme) return "";

  return readme
    .split(/\n\s*\n/)
    .map((section) => section.replace(/^#+\s*/gm, "").trim())
    .find((section) => section.length > 40)
    ?.slice(0, 700);
}

const NOT_INDEXED_NOTE =
  "This repository has not been indexed yet, so I can only see its README, package.json, and file tree. Re-add it to index its source files.";

function formatExcerpt(excerpt) {
  return `\`${excerpt.path}\` (lines ${excerpt.startLine}-${excerpt.endLine}):\n\`\`\`\n${excerpt.content}\n\`\`\``;
}

function buildSourceList(excerpts) {
  return excerpts
    .map(
      (excerpt) =>
        `\`${excerpt.path}\` (lines ${excerpt.startLine}-${excerpt.endLine})`,
    )
    .join(", ");
}

function buildCodeSection(excerpts) {
  if (excerpts.length === 0) return "";

  return `\n\nRelevant indexed code:\n\n${excerpts
    .slice(0, 2)
    .map(formatExcerpt)
    .join("\n\n")}`;
}

function buildRepositoryContext({
  repository,
  details,
  packageInfo,
  readme,
  excerpts = [],
}) {
  const topDirectories = getTopLevelNames(details.tree, "directory");
  const topFiles = getTopLevelNames(details.tree, "file");
  const scripts = Object.entries(packageInfo?.scripts || {});
  const dependencies = packageInfo?.dependencies || [];
  const devDependencies = packageInfo?.devDependencies || [];
  const excerptSection =
    excerpts.length > 0
      ? `\n\nRelevant code excerpts retrieved from the index:\n${excerpts
          .map(
            (excerpt) =>
              `${excerpt.path} (lines ${excerpt.startLine}-${excerpt.endLine}):\n${excerpt.content}`,
          )
          .join("\n\n")}`
      : "";

  return [
    `Repository: ${repository.name}`,
    `URL: ${repository.url}`,
    `Local path: ${repository.localPath}`,
    `Indexed files: ${details.fileCount}`,
    `Indexed folders: ${details.directoryCount}`,
    `Top-level folders: ${topDirectories.join(", ") || "none found"}`,
    `Top-level files: ${topFiles.join(", ") || "none found"}`,
    `Package name: ${packageInfo?.name || "not found"}`,
    `Package description: ${packageInfo?.description || "not found"}`,
    `Scripts: ${
      scripts.map(([name, command]) => `${name}: ${command}`).join("; ") ||
      "none found"
    }`,
    `Dependencies: ${dependencies.slice(0, 40).join(", ") || "none found"}`,
    `Dev dependencies: ${
      devDependencies.slice(0, 30).join(", ") || "none found"
    }`,
    `README excerpt:\n${readme.slice(0, 5000) || "No README found."}`,
  ].join("\n") + excerptSection;
}

async function answerWithNim(repositoryContext, question) {
  const {
    apiKey,
    chatApiUrl: apiUrl,
    chatModel: model,
  } = getResolvedSettings().ai;

  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "You are Atlas, a senior codebase onboarding assistant. Answer using only the repository context provided, including the retrieved code excerpts. Be concise, practical, and specific. Cite the exact file paths you relied on. When useful, suggest files, folders, or package scripts to inspect. If the context is insufficient, say what is missing instead of guessing.",
          },
          {
            role: "user",
            content: `Repository context:\n${repositoryContext}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `NVIDIA NIM request failed: ${response.status} ${errorText}`,
      );
    }

    const payload = await response.json();
    return payload.choices?.[0]?.message?.content?.trim() || null;
  } finally {
    clearTimeout(timeout);
  }
}

function answerRepositoryQuestion(
  { repository, details, packageInfo, readme, excerpts = [] },
  question,
) {
  const normalizedQuestion = question.toLowerCase();
  const topDirectories = getTopLevelNames(details.tree, "directory");
  const topFiles = getTopLevelNames(details.tree, "file");
  const scripts = Object.entries(packageInfo?.scripts || {});
  const dependencies = packageInfo?.dependencies || [];
  const devDependencies = packageInfo?.devDependencies || [];
  const intro =
    firstReadmeParagraph(readme) ||
    `${repository.name} contains ${details.fileCount} files across ${details.directoryCount} folders.`;
  // The retrieved files are named in every answer so the user can verify it,
  // and quoted in full when the question is about specific code.
  const sources =
    excerpts.length > 0
      ? `\n\nMost relevant indexed files: ${buildSourceList(excerpts)}.`
      : "";

  if (normalizedQuestion.includes("run") || normalizedQuestion.includes("start")) {
    if (scripts.length === 0) {
      return `I could not find npm scripts in this repository. Start by opening the top-level files (${topFiles.join(", ") || "none found"}) and checking the README for setup instructions.${sources}`;
    }

    return `To run this codebase, use the scripts in \`package.json\`:\n\n${scripts
      .map(([name, command]) => `- \`npm run ${name}\`: \`${command}\``)
      .join("\n")}\n\nFor onboarding, start with \`README.md\`, then inspect ${topDirectories.slice(0, 4).map((name) => `\`${name}\``).join(", ") || "the top-level folders"}.${sources}`;
  }

  if (
    normalizedQuestion.includes("read first") ||
    normalizedQuestion.includes("where") ||
    normalizedQuestion.includes("start")
  ) {
    return `I would start here:\n\n- \`README.md\` for project intent and setup.\n- \`package.json\` for scripts and dependencies.\n- Top-level folders: ${topDirectories.map((name) => `\`${name}\``).join(", ") || "none found"}.\n- Top-level files: ${topFiles.map((name) => `\`${name}\``).join(", ") || "none found"}.\n\nThis repo currently indexes as ${details.fileCount} files in ${details.directoryCount} folders.${sources}`;
  }

  if (
    normalizedQuestion.includes("depend") ||
    normalizedQuestion.includes("stack") ||
    normalizedQuestion.includes("tech")
  ) {
    const primaryDependencies = dependencies.slice(0, 12);
    const primaryDevDependencies = devDependencies.slice(0, 8);

    return `The visible stack from \`package.json\` is:\n\n- Dependencies: ${primaryDependencies.map((name) => `\`${name}\``).join(", ") || "none listed"}.\n- Dev dependencies: ${primaryDevDependencies.map((name) => `\`${name}\``).join(", ") || "none listed"}.\n\nThe main scripts are ${scripts.map(([name]) => `\`${name}\``).join(", ") || "not listed"}.${sources}`;
  }

  if (
    normalizedQuestion.includes("what") ||
    normalizedQuestion.includes("overview") ||
    normalizedQuestion.includes("explain")
  ) {
    return `${intro}\n\nQuick structure:\n\n- ${details.fileCount} files\n- ${details.directoryCount} folders\n- Top folders: ${topDirectories.map((name) => `\`${name}\``).join(", ") || "none found"}\n- Top files: ${topFiles.map((name) => `\`${name}\``).join(", ") || "none found"}${sources}${buildCodeSection(excerpts)}`;
  }

  if (excerpts.length > 0) {
    return `Here is the most relevant code I found in the index:\n\n${excerpts
      .slice(0, 2)
      .map(formatExcerpt)
      .join("\n\n")}${sources}`;
  }

  return `Here is what I can tell from the indexed repository:\n\n${intro}\n\nUseful entry points are ${topFiles.map((name) => `\`${name}\``).join(", ") || "the top-level files"} and ${topDirectories.map((name) => `\`${name}\``).join(", ") || "the top-level folders"}. Ask me things like "How do I run this?", "What should I read first?", or "What stack does this use?"`;
}

const AI_TEST_TIMEOUT_MS = 15 * 1000;

function truncateText(value, limit = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function postAiRequest({ url, apiKey, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${truncateText(text)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("The provider returned a response that was not JSON.");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The provider did not respond in time.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// A settings save that leaves a typo'd key, model, or URL behind is the exact
// failure this page exists to prevent, so the check exercises both requests the
// app actually makes: a small chat completion and an embedding.
async function testAiConnection() {
  const { ai } = getResolvedSettings();

  if (!ai.apiKey) {
    return {
      ok: false,
      error:
        "No API key configured. Add one above, or set NVIDIA_NIM_API_KEY.",
      chat: null,
      embeddings: null,
    };
  }

  const [chat, embeddings] = await Promise.all([
    postAiRequest({
      url: ai.chatApiUrl,
      apiKey: ai.apiKey,
      body: {
        model: ai.chatModel,
        temperature: 0,
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply with OK." }],
      },
    })
      .then(() => ({ ok: true, message: "Chat model responded." }))
      .catch((error) => ({ ok: false, error: error.message })),
    postAiRequest({
      url: ai.embedApiUrl,
      apiKey: ai.apiKey,
      body: {
        model: ai.embedModel,
        input: ["Atlas connection test"],
        input_type: "query",
      },
    })
      .then((payload) => {
        const dimensions = payload?.data?.[0]?.embedding?.length;

        if (!dimensions) {
          throw new Error("The embeddings endpoint returned no vector.");
        }

        return {
          ok: true,
          message: `Embedding model responded (${dimensions} dimensions).`,
        };
      })
      .catch((error) => ({ ok: false, error: error.message })),
  ]);

  return { ok: chat.ok && embeddings.ok, chat, embeddings };
}

async function getDirectorySize(directoryPath) {
  let entries;
  let total = 0;

  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
      continue;
    }

    try {
      total += (await fs.stat(entryPath)).size;
    } catch {
      // A file that vanished mid-walk is not worth failing the page over.
    }
  }

  return total;
}

async function getStorageInfo() {
  const { atlasRoot, repositoriesRoot } = getAtlasPaths();
  const databasePath = path.join(atlasRoot, "atlas.db");
  let databaseBytes = 0;

  // WAL and SHM only exist while the database is open and writes are pending;
  // a missing one is simply zero bytes.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      databaseBytes += (await fs.stat(`${databasePath}${suffix}`)).size;
    } catch {
      // Ignore missing database sidecar files.
    }
  }

  return {
    dataPath: atlasRoot,
    databaseBytes,
    repositoriesBytes: await getDirectorySize(repositoriesRoot),
    repositoryCount: listRepositories().length,
  };
}

function registerIpcHandlers() {
  ipcMain.handle("settings:get", async () => {
    return getPublicSettings();
  });

  ipcMain.handle("settings:set", async (event, patch) => {
    const updated = updateSettings(patch);
    const mainWindow = BrowserWindow.fromWebContents(event.sender);

    // Apply the parts of the change the main process owns, then tell the
    // renderer so every open view re-reads the new values.
    applyThemeToWindow(mainWindow);
    scheduleSyncPolling();
    mainWindow?.webContents?.send("settings:changed", updated);

    return updated;
  });

  ipcMain.handle("settings:test-connection", async () => {
    return testAiConnection();
  });

  ipcMain.handle("settings:storage-info", async () => {
    return getStorageInfo();
  });

  ipcMain.handle("settings:open-storage", async () => {
    const { shell } = require("electron");
    const { atlasRoot } = getAtlasPaths();
    const error = await shell.openPath(atlasRoot);

    if (error) {
      throw new Error(error);
    }

    return { path: atlasRoot };
  });

  ipcMain.handle("workspaces:list", async () => {
    return listWorkspaces();
  });

  ipcMain.handle("workspaces:create", async (event, patch) => {
    const workspace = createWorkspace(patch ?? {});
    notifyWorkspacesChanged(event);

    return workspace;
  });

  ipcMain.handle("workspaces:update", async (event, payload = {}) => {
    const { workspaceId, patch } = payload;
    const workspace = updateWorkspace(workspaceId, patch ?? {});
    notifyWorkspacesChanged(event);

    return workspace;
  });

  ipcMain.handle("workspaces:remove", async (event, workspaceId) => {
    const result = deleteWorkspace(workspaceId);
    const mainWindow = BrowserWindow.fromWebContents(event.sender);

    // Deleting the selected workspace leaves the persisted selection pointing
    // at a row that no longer exists. Adopt the default now so every later
    // read (and the next launch) agrees with what repositories:list returns.
    if (getResolvedSettings().general.activeWorkspaceId === result.id) {
      const fallbackWorkspaceId = listWorkspaces()[0]?.id ?? null;
      const updatedSettings = updateSettings({
        general: { activeWorkspaceId: fallbackWorkspaceId },
      });

      mainWindow?.webContents?.send("settings:changed", updatedSettings);
    }

    mainWindow?.webContents?.send("workspaces:changed");
    mainWindow?.webContents?.send("repositories:changed");

    return result;
  });

  // Scoped to the active workspace: the sidebar shows one workspace at a time,
  // while storage accounting and the legacy channels still see every row.
  ipcMain.handle("repositories:list", async () => {
    return listRepositories(getActiveWorkspaceId());
  });

  ipcMain.handle("repositories:move", async (event, { repositoryId, workspaceId }) => {
    const result = moveRepositoryToWorkspace(repositoryId, workspaceId);
    const mainWindow = BrowserWindow.fromWebContents(event.sender);

    // The source and target workspace counts both changed, and a repository
    // just left (or entered) the visible list.
    mainWindow?.webContents?.send("workspaces:changed");
    mainWindow?.webContents?.send("repositories:changed");

    return result;
  });

  ipcMain.handle("repositories:add", async (event, repositoryUrl) => {
    const trimmedUrl = validateRepositoryUrl(repositoryUrl);
    const name = getRepositoryName(trimmedUrl);
    const slug = getRepositorySlug(name);
    const id = `${slug}-${Date.now()}`;
    const { repositoriesRoot } = await ensureAtlasStorage();
    const localPath = path.join(repositoriesRoot, id);
    const addedAt = new Date().toISOString();
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    // Captured up front: the user expects the clone to land in the workspace
    // that was selected when they asked for it.
    const workspaceId = getActiveWorkspaceId();

    try {
      await simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } }).clone(
        trimmedUrl,
        localPath,
        ["--depth", "1"],
      );

      // Index before recording the repository so a failed index cannot leave a
      // repository entry behind with no files. The indexer writes the SQLite row,
      // so the repository is only visible once it has been indexed.
      await new IndexerService().indexRepo(
        localPath,
        mainWindow,
        { externalId: id, name, url: trimmedUrl, addedAt, workspaceId },
        { timeoutMs: INDEX_TIMEOUT_MS, embedder: getNimEmbedder() },
      );
    } catch (error) {
      // A failed clone or index must not leave a half-written repository folder
      // behind on disk.
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    notifyWorkspacesChanged(event);

    return inspectRepository(findRepository(id));
  });

  ipcMain.handle("repositories:remove", async (event, repositoryId) => {
    const repository = findRepository(repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    // Record the deletion before purging the row. Both calls are synchronous,
    // so nothing can interleave between them; a backfill index that commits
    // after this point sees the mark and removes the row it just rewrote.
    markRepositoryDeleted(repository.localPath);

    if (deleteRepository(repositoryId) === 0) {
      throw new Error("Repository not found.");
    }

    // Only delete the clone when it lives inside the folder the app manages.
    // Imports and legacy rows can point at a checkout the user already had, and
    // removing the repository must not delete the user's own working copy.
    if (isManagedRepositoryPath(repository.localPath)) {
      await fs
        .rm(path.resolve(repository.localPath), { recursive: true, force: true })
        .catch((error) => {
          // The row is already gone, so the repository is deleted from the user's
          // point of view; an orphaned folder is not worth failing the request.
          console.warn(
            `Failed to delete cloned folder ${repository.localPath}:`,
            error,
          );
        });
    }

    BrowserWindow.fromWebContents(event.sender)?.webContents?.send(
      "repositories:changed",
    );
    notifyWorkspacesChanged(event);

    return { id: repository.id };
  });

  ipcMain.handle("repositories:inspect", async (_, repositoryId) => {
    const repository = findRepository(repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    return inspectRepository(repository);
  });

  // Manual refresh: the same check the background poller runs, but on demand so
  // the user does not have to wait for the next pass. With no id every
  // repository is checked, which is what a global "refresh" button asks for.
  ipcMain.handle("repositories:sync", async (event, repositoryId) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);

    if (repositoryId === undefined || repositoryId === null) {
      const results = await syncAllRepositories(mainWindow);

      if (results.some((result) => result.changed)) {
        mainWindow?.webContents?.send("repositories:changed");
      }

      return summarizeSync(results);
    }

    const repository = findRepository(repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    const result = await syncRepository(repository, mainWindow);

    if (result.changed) {
      mainWindow?.webContents?.send("repositories:changed");
    }

    return result;
  });

  ipcMain.handle(
    "repositories:discard-changes",
    async (event, repositoryId) => {
      const repository = findRepository(repositoryId);

      if (!repository) {
        throw new Error("Repository not found.");
      }

      const mainWindow = BrowserWindow.fromWebContents(event.sender);

      await discardRepositoryChanges(repository, mainWindow);

      mainWindow?.webContents?.send("repositories:changed");

      return inspectRepository(findRepository(repositoryId));
    },
  );

  ipcMain.handle("repositories:ask", async (_, { repositoryId, question }) => {
    if (!question || typeof question !== "string") {
      throw new Error("Ask a question about this repository.");
    }

    const repository = findRepository(repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    const trimmedQuestion = question.trim();
    const details = await inspectRepository(repository);
    const [packageJsonText, readme] = await Promise.all([
      readOptionalText(path.join(repository.localPath, "package.json")),
      readRepositoryReadme(repository.localPath),
    ]);
    // Pull the most relevant indexed source files so answers are grounded in
    // the code itself, not just the README and file tree. Retrieval prefers
    // chunks matched by meaning and falls back to lexical ranking, so a
    // repository indexed without embeddings is still answerable.
    const excerpts = await retrieveRepositoryExcerpts(
      repository.id,
      trimmedQuestion,
      { embedder: getNimEmbedder() },
    );

    const answerContext = {
      repository,
      details,
      packageInfo: summarizePackageJson(packageJsonText),
      readme,
      excerpts,
    };

    // Nothing was indexed, so there is no code to ground an answer in. Say so
    // rather than letting the model guess from the README alone.
    if (repository.fileCount === 0) {
      return `${NOT_INDEXED_NOTE}\n\n${answerRepositoryQuestion(
        answerContext,
        trimmedQuestion,
      )}`;
    }

    // Impact, symbol-usage, and unreachability questions have a deterministic
    // answer in the graph, which beats a lexical guess or the model reading
    // excerpts. Anything it cannot resolve falls through to those.
    try {
      const graphAnswer = answerRepositoryGraphQuestion(
        repository.id,
        trimmedQuestion,
      );

      if (graphAnswer) return graphAnswer;
    } catch (error) {
      console.error("Failed to answer from the graph:", error);
    }

    // Ownership and recency come from the clone's git history, which the graph
    // cannot see. Falls through to retrieval when it has nothing to say.
    try {
      const ownershipAnswer = await answerRepositoryOwnershipQuestion(
        repository.id,
        trimmedQuestion,
      );

      if (ownershipAnswer) return ownershipAnswer;
    } catch (error) {
      console.error("Failed to answer from git history:", error);
    }

    try {
      const nimAnswer = await answerWithNim(
        buildRepositoryContext(answerContext),
        trimmedQuestion,
      );

      if (nimAnswer) return nimAnswer;
    } catch (error) {
      console.error(error);
    }

    return answerRepositoryQuestion(answerContext, trimmedQuestion);
  });

  ipcMain.handle("index-repo", async (event, { repoPath }) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await new IndexerService().indexRepo(
      repoPath,
      mainWindow,
      {},
      { timeoutMs: INDEX_TIMEOUT_MS, embedder: getNimEmbedder() },
    );
    return { success: true, ...result };
  });

  ipcMain.handle("get-graph", async (_, { repoId }) => {
    return getRepositoryGraph(repoId);
  });

  ipcMain.handle("get-start-here", async (_, { repoId }) => {
    return getStartHere(repoId);
  });

  ipcMain.handle("get-impact", async (_, { repoId, path: filePath }) => {
    return getImpact(repoId, filePath);
  });

  ipcMain.handle("get-ownership", async (_, { repoId, path: filePath }) => {
    return getOwnership(repoId, filePath);
  });

  ipcMain.handle("get-repos", async () => {
    return listRepositories();
  });
}

// Keeps the native titlebar symbols legible against the renderer's theme. The
// renderer applies the `.dark` class itself; nativeTheme makes native surfaces
// (dialogs, menus) follow the same choice.
function applyThemeToWindow(win) {
  const { theme } = getResolvedSettings().general;
  let nativeTheme = null;

  try {
    nativeTheme = require("electron").nativeTheme ?? null;
  } catch {
    // Tests run without a full Electron runtime.
  }

  if (nativeTheme) {
    nativeTheme.themeSource = theme;
  }

  const prefersDark =
    theme === "dark" || (theme === "system" && nativeTheme?.shouldUseDarkColors);

  win?.setTitleBarOverlay?.({
    color: "rgba(0,0,0,0)",
    symbolColor: prefersDark ? "#ffffff" : "#1a1a1a",
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minHeight: 600,
    minWidth: 1000,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "rgba(0,0,0,0)",
      // Replaced by applyThemeToWindow as soon as the window exists; this
      // matches the light theme the renderer starts in.
      symbolColor: "#1a1a1a",
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();

  if (isDev) {
    win.loadURL("http://localhost:5173");
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../dist/renderer/index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  await loadLocalEnv();
  const { atlasRoot } = await ensureAtlasStorage();
  // Loaded before the window so the saved theme and sync policy apply from the
  // first frame rather than being corrected after the renderer mounts.
  initializeSettings(path.join(atlasRoot, "settings.json"));
  // Adoption runs on every launch rather than only when initializeDatabase
  // opens the file: another module (or the CLI) may have initialized the
  // singleton earlier, and a repository without a workspace would otherwise
  // be invisible in the sidebar.
  ensureDefaultWorkspace(initializeDatabase(path.join(atlasRoot, "atlas.db")));
  await migrateLegacyRepositories();
  registerIpcHandlers();
  const mainWindow = createWindow();
  applyThemeToWindow(mainWindow);
  // Fire-and-forget: indexing must not stop the window from appearing.
  backfillRepositoryIndexes(mainWindow).catch((error) =>
    console.error("Repository index backfill failed:", error),
  );
  // Keeps cloned repositories level with their remotes while the app is open.
  startSyncPoller(mainWindow);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
