const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const simpleGit = require("simple-git");

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_NIM_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_NIM_MODEL = "deepseek-ai/deepseek-v4-pro";
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
  const { atlasRoot, repositoriesRoot, storePath } = getAtlasPaths();

  await fs.mkdir(repositoriesRoot, { recursive: true });

  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, "[]", "utf8");
  }

  return { atlasRoot, repositoriesRoot, storePath };
}

async function readRepositories() {
  const { storePath } = await ensureAtlasStorage();
  const contents = await fs.readFile(storePath, "utf8");

  try {
    return JSON.parse(contents);
  } catch {
    return [];
  }
}

async function writeRepositories(repositories) {
  const { storePath } = await ensureAtlasStorage();
  await fs.writeFile(storePath, JSON.stringify(repositories, null, 2), "utf8");
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
    fileCount: summary.fileCount,
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

function buildRepositoryContext({ repository, details, packageInfo, readme }) {
  const topDirectories = getTopLevelNames(details.tree, "directory");
  const topFiles = getTopLevelNames(details.tree, "file");
  const scripts = Object.entries(packageInfo?.scripts || {});
  const dependencies = packageInfo?.dependencies || [];
  const devDependencies = packageInfo?.devDependencies || [];

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
  ].join("\n");
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
            "You are Atlas, a senior codebase onboarding assistant. Answer using only the repository context provided. Be concise, practical, and specific. When useful, suggest exact files, folders, or package scripts to inspect. If the context is insufficient, say what is missing instead of guessing.",
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

function answerRepositoryQuestion({ repository, details, packageInfo, readme }, question) {
  const normalizedQuestion = question.toLowerCase();
  const topDirectories = getTopLevelNames(details.tree, "directory");
  const topFiles = getTopLevelNames(details.tree, "file");
  const scripts = Object.entries(packageInfo?.scripts || {});
  const dependencies = packageInfo?.dependencies || [];
  const devDependencies = packageInfo?.devDependencies || [];
  const intro =
    firstReadmeParagraph(readme) ||
    `${repository.name} contains ${details.fileCount} files across ${details.directoryCount} folders.`;

  if (normalizedQuestion.includes("run") || normalizedQuestion.includes("start")) {
    if (scripts.length === 0) {
      return `I could not find npm scripts in this repository. Start by opening the top-level files (${topFiles.join(", ") || "none found"}) and checking the README for setup instructions.`;
    }

    return `To run this codebase, use the scripts in \`package.json\`:\n\n${scripts
      .map(([name, command]) => `- \`npm run ${name}\`: \`${command}\``)
      .join("\n")}\n\nFor onboarding, start with \`README.md\`, then inspect ${topDirectories.slice(0, 4).map((name) => `\`${name}\``).join(", ") || "the top-level folders"}.`;
  }

  if (
    normalizedQuestion.includes("read first") ||
    normalizedQuestion.includes("where") ||
    normalizedQuestion.includes("start")
  ) {
    return `I would start here:\n\n- \`README.md\` for project intent and setup.\n- \`package.json\` for scripts and dependencies.\n- Top-level folders: ${topDirectories.map((name) => `\`${name}\``).join(", ") || "none found"}.\n- Top-level files: ${topFiles.map((name) => `\`${name}\``).join(", ") || "none found"}.\n\nThis repo currently indexes as ${details.fileCount} files in ${details.directoryCount} folders.`;
  }

  if (
    normalizedQuestion.includes("depend") ||
    normalizedQuestion.includes("stack") ||
    normalizedQuestion.includes("tech")
  ) {
    const primaryDependencies = dependencies.slice(0, 12);
    const primaryDevDependencies = devDependencies.slice(0, 8);

    return `The visible stack from \`package.json\` is:\n\n- Dependencies: ${primaryDependencies.map((name) => `\`${name}\``).join(", ") || "none listed"}.\n- Dev dependencies: ${primaryDevDependencies.map((name) => `\`${name}\``).join(", ") || "none listed"}.\n\nThe main scripts are ${scripts.map(([name]) => `\`${name}\``).join(", ") || "not listed"}.`;
  }

  if (
    normalizedQuestion.includes("what") ||
    normalizedQuestion.includes("overview") ||
    normalizedQuestion.includes("explain")
  ) {
    return `${intro}\n\nQuick structure:\n\n- ${details.fileCount} files\n- ${details.directoryCount} folders\n- Top folders: ${topDirectories.map((name) => `\`${name}\``).join(", ") || "none found"}\n- Top files: ${topFiles.map((name) => `\`${name}\``).join(", ") || "none found"}`;
  }

  return `Here is what I can tell from the indexed repository:\n\n${intro}\n\nUseful entry points are ${topFiles.map((name) => `\`${name}\``).join(", ") || "the top-level files"} and ${topDirectories.map((name) => `\`${name}\``).join(", ") || "the top-level folders"}. Ask me things like "How do I run this?", "What should I read first?", or "What stack does this use?"`;
}

function registerIpcHandlers() {
  ipcMain.handle("repositories:list", async () => {
    return readRepositories();
  });

  ipcMain.handle("repositories:add", async (_, repositoryUrl) => {
    if (!repositoryUrl || typeof repositoryUrl !== "string") {
      throw new Error("Enter a repository URL.");
    }

    const trimmedUrl = repositoryUrl.trim();
    const name = getRepositoryName(trimmedUrl);
    const slug = getRepositorySlug(name);
    const { repositoriesRoot } = await ensureAtlasStorage();
    const localPath = path.join(repositoriesRoot, `${slug}-${Date.now()}`);

    await simpleGit().clone(trimmedUrl, localPath, ["--depth", "1"]);

    const repository = {
      id: `${slug}-${Date.now()}`,
      name,
      url: trimmedUrl,
      localPath,
      addedAt: new Date().toISOString(),
    };
    const repositories = await readRepositories();

    await writeRepositories([repository, ...repositories]);

    return inspectRepository(repository);
  });

  ipcMain.handle("repositories:inspect", async (_, repositoryId) => {
    const repositories = await readRepositories();
    const repository = repositories.find((item) => item.id === repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    return inspectRepository(repository);
  });

  ipcMain.handle("repositories:ask", async (_, { repositoryId, question }) => {
    if (!question || typeof question !== "string") {
      throw new Error("Ask a question about this repository.");
    }

    const repositories = await readRepositories();
    const repository = repositories.find((item) => item.id === repositoryId);

    if (!repository) {
      throw new Error("Repository not found.");
    }

    const details = await inspectRepository(repository);
    const [packageJsonText, readme] = await Promise.all([
      readOptionalText(path.join(repository.localPath, "package.json")),
      readRepositoryReadme(repository.localPath),
    ]);

    const answerContext = {
      repository,
      details,
      packageInfo: summarizePackageJson(packageJsonText),
      readme,
    };

    try {
      const nimAnswer = await answerWithNim(
        buildRepositoryContext(answerContext),
        question.trim(),
      );

      if (nimAnswer) return nimAnswer;
    } catch (error) {
      console.error(error);
    }

    return answerRepositoryQuestion(answerContext, question.trim());
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
}

app.whenReady().then(async () => {
  await loadLocalEnv();
  registerIpcHandlers();
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
