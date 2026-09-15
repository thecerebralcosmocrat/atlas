const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const simpleGit = require("simple-git");
const { initializeDatabase } = require("./db/schema");
const {
  listRepositories,
  listUnindexedRepositories,
  listRepositoriesWithoutChunks,
  findRepository,
  legacyRepositoriesImported,
  importLegacyRepositories,
} = require("./db/repositories");
const { IndexerService } = require("./indexer/IndexerService");
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

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_NIM_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_NIM_MODEL = "deepseek-ai/deepseek-v4-pro";

// Embeddings use the same NIM account as the answers. Built per use rather than
// cached so it always sees the environment loadLocalEnv has loaded, and it
// returns null without a key: semantic retrieval is an enhancement, so a
// missing key must not stop indexing or answering questions.
function getNimEmbedder() {
  return createNimEmbedder({
    apiKey: process.env.NVIDIA_NIM_API_KEY,
    model: process.env.NVIDIA_NIM_EMBED_MODEL,
    apiUrl: process.env.NVIDIA_NIM_EMBED_API_URL,
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

async function ensureAtlasStorage() {
  const { atlasRoot, repositoriesRoot } = getAtlasPaths();

  await fs.mkdir(repositoriesRoot, { recursive: true });

  return { atlasRoot, repositoriesRoot };
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
        },
        { timeoutMs: INDEX_TIMEOUT_MS, embedder },
      );
    } catch (error) {
      console.error(`Failed to index ${repository.name}:`, error);
    }
  }

  mainWindow?.webContents?.send("repositories:changed");
}

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
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
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  const apiUrl = process.env.NVIDIA_NIM_API_URL || DEFAULT_NIM_API_URL;
  const model = process.env.NVIDIA_NIM_MODEL || DEFAULT_NIM_MODEL;

  if (!apiKey) {
    return null;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
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
    throw new Error(`NVIDIA NIM request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return payload.choices?.[0]?.message?.content?.trim() || null;
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

function registerIpcHandlers() {
  ipcMain.handle("repositories:list", async () => {
    return listRepositories();
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
        { externalId: id, name, url: trimmedUrl, addedAt },
        { timeoutMs: INDEX_TIMEOUT_MS, embedder: getNimEmbedder() },
      );
    } catch (error) {
      // A failed clone or index must not leave a half-written repository folder
      // behind on disk.
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    return inspectRepository(findRepository(id));
  });

  ipcMain.handle("repositories:inspect", async (_, repositoryId) => {
    const repository = findRepository(repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    return inspectRepository(repository);
  });

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minHeight: 600,
    minWidth: 1000,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "rgba(0,0,0,0)",
      symbolColor: "#ffffff",
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
  initializeDatabase(path.join(atlasRoot, "atlas.db"));
  await migrateLegacyRepositories();
  registerIpcHandlers();
  const mainWindow = createWindow();
  // Fire-and-forget: indexing must not stop the window from appearing.
  backfillRepositoryIndexes(mainWindow).catch((error) =>
    console.error("Repository index backfill failed:", error),
  );
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
