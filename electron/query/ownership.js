// Answers who has touched the code and what changed lately, from the git
// history of the clone the app already has.
//
// `parseGitLog`, `buildOwnership`, and `answerOwnershipQuestion` are pure so the
// ranking can be tested without a repository, mirroring query/impact.js.
// `readGitHistory` and `getOwnership` are the git-backed wrappers.
//
// The app clones with `--depth 1`, so history starts as a single commit. The
// first ownership read deepens the clone by a bounded number of commits (and
// tolerates being offline) so churn and reviewers are more than the one commit
// the clone was born with; a clone that stays shallow says so in the answer.

const simpleGit = require("simple-git");

const { getDb } = require("../db/schema");
const { toPosix } = require("../indexer/ImportResolver");
const { findRepoPrimaryKey } = require("./graph");
const { isTestPath } = require("./entrypoints");
const { resolveGraphTarget } = require("./impact");

// git is told to prefix each commit header with these, so a log line can never
// be confused with a tracked path.
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

const HISTORY_MAX_COMMITS = 5000;
const GIT_TIMEOUT_MS = 30_000;
const DEEPEN_COMMITS = 200;
const DEFAULT_LIMIT = 8;

// "who owns this" and "what changed lately". Kept narrow so an import or symbol
// question reaches query/impact.js first and this never steals its answer.
const OWNERSHIP_INTENT =
  /\bwho\b[^.?!]{0,60}\b(owns?|owning|maintains?|maintainers?|wrote|writes?|authored?|touched|touches|changed|changes|should\s+i\s+ask|to\s+ask|contact|reviews?|reviewers?|expert|knows?)\b|\b(likely\s+reviewers?|code\s+owners?|git\s+blame|blame)\b/i;
const RECENCY_INTENT =
  /\b(churn|hot\s*spots?|recently\s+changed|recent\s+changes?|last\s+changed|most\s+changed|frequently\s+changed|active\s+files?|activity|what\s+changed|change\s+history|commit\s+history|stale)\b/i;

// A depth-limited read is attempted once per clone per process, and the
// in-flight promise is shared: two concurrent reads (the Explorer panel and a
// chat question, or a StrictMode double effect) must both wait for the same
// fetch rather than the second one reading the stale shallow log.
const deepenAttempts = new Map();

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function shortDate(value) {
  return String(value ?? "").slice(0, 10);
}

// Turns `git log --name-only --pretty=format:<record>` into commit records.
// Blank lines separate the header from its paths and are skipped; a path is
// kept verbatim so a name with spaces still matches an indexed path.
function parseGitLog(raw) {
  const commits = [];

  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.startsWith(RECORD_SEPARATOR)) {
      const [hash, authorName, authorEmail, date] = line
        .slice(RECORD_SEPARATOR.length)
        .split(FIELD_SEPARATOR);

      commits.push({
        hash: hash ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        paths: [],
      });
      continue;
    }

    const commit = commits[commits.length - 1];
    const filePath = line.trim();

    if (commit && filePath) commit.paths.push(filePath);
  }

  return commits;
}

function authorKey(author) {
  return String(author?.authorEmail || author?.authorName || "");
}

// Annotates every indexed file with how often it changed, when it last changed,
// and who touched it most. Files git never saw (or that only appear outside the
// index) keep a zero-commit entry so the picker can still offer them.
function buildOwnership({ files = [], commits = [], limit = DEFAULT_LIMIT }) {
  const fileIdByPath = new Map();

  for (const file of files) {
    if (!file || file.path === undefined || file.path === null) continue;

    const posixPath = toPosix(file.path);

    if (!fileIdByPath.has(posixPath)) fileIdByPath.set(posixPath, file.id ?? null);
  }

  const statsByPath = new Map();

  for (const commit of commits) {
    const timestamp = Date.parse(commit.date);
    const hasTimestamp = !Number.isNaN(timestamp);

    for (const rawPath of commit.paths ?? []) {
      const filePath = toPosix(rawPath);

      if (!fileIdByPath.has(filePath)) continue;

      const stats =
        statsByPath.get(filePath) ??
        {
          commitCount: 0,
          lastChangedAt: null,
          lastTimestamp: null,
          lastAuthor: null,
          authors: new Map(),
        };

      stats.commitCount += 1;

      if (hasTimestamp && (stats.lastTimestamp === null || timestamp > stats.lastTimestamp)) {
        stats.lastTimestamp = timestamp;
        stats.lastChangedAt = commit.date;
        stats.lastAuthor = { name: commit.authorName, email: commit.authorEmail };
      }

      const key = authorKey(commit);
      const author =
        stats.authors.get(key) ??
        {
          name: commit.authorName,
          email: commit.authorEmail,
          count: 0,
          lastChangedAt: null,
          lastTimestamp: null,
        };

      author.count += 1;

      if (hasTimestamp && (author.lastTimestamp === null || timestamp > author.lastTimestamp)) {
        author.lastTimestamp = timestamp;
        author.lastChangedAt = commit.date;
      }

      stats.authors.set(key, author);
      statsByPath.set(filePath, stats);
    }
  }

  const fileEntries = [...fileIdByPath.entries()]
    .map(([filePath, fileId]) => {
      const stats = statsByPath.get(filePath);

      if (!stats) {
        return {
          fileId,
          path: filePath,
          commitCount: 0,
          lastChangedAt: null,
          lastAuthor: null,
          authors: [],
        };
      }

      return {
        fileId,
        path: filePath,
        commitCount: stats.commitCount,
        lastChangedAt: stats.lastChangedAt,
        lastAuthor: stats.lastAuthor,
        authors: [...stats.authors.values()]
          .map((author) => ({
            name: author.name,
            email: author.email,
            count: author.count,
            lastChangedAt: author.lastChangedAt,
          }))
          .sort(
            (left, right) =>
              right.count - left.count || compareText(left.name, right.name),
          ),
      };
    })
    .sort((left, right) => compareText(left.path, right.path));

  const contributorsByKey = new Map();

  for (const commit of commits) {
    const key = authorKey(commit);
    const timestamp = Date.parse(commit.date);
    const contributor =
      contributorsByKey.get(key) ??
      {
        name: commit.authorName,
        email: commit.authorEmail,
        commitCount: 0,
        paths: new Set(),
        lastChangedAt: null,
        lastTimestamp: null,
      };

    contributor.commitCount += 1;

    if (!Number.isNaN(timestamp) && (contributor.lastTimestamp === null || timestamp > contributor.lastTimestamp)) {
      contributor.lastTimestamp = timestamp;
      contributor.lastChangedAt = commit.date;
    }

    for (const rawPath of commit.paths ?? []) {
      const filePath = toPosix(rawPath);

      if (fileIdByPath.has(filePath)) contributor.paths.add(filePath);
    }

    contributorsByKey.set(key, contributor);
  }

  const contributors = [...contributorsByKey.values()]
    .map((contributor) => ({
      name: contributor.name,
      email: contributor.email,
      commitCount: contributor.commitCount,
      fileCount: contributor.paths.size,
      lastChangedAt: contributor.lastChangedAt,
    }))
    .sort(
      (left, right) =>
        right.commitCount - left.commitCount || compareText(left.name, right.name),
    );

  // Tests churn constantly, so they would crowd out the application code a new
  // hire is actually trying to understand.
  const hotspots = fileEntries
    .filter((file) => file.commitCount > 0 && !isTestPath(file.path))
    .sort(
      (left, right) =>
        right.commitCount - left.commitCount || compareText(left.path, right.path),
    )
    .slice(0, Math.max(0, limit))
    .map((file) => ({
      fileId: file.fileId,
      path: file.path,
      commitCount: file.commitCount,
    }));

  // Tests are excluded from both rankings for the same reason as hotspots.
  // Ordering uses the parsed timestamp, not the ISO text: a local-clock string
  // like `17:00-08:00` is later than `16:00+00:00` even though it sorts first.
  const recent = fileEntries
    .filter(
      (file) =>
        file.commitCount > 0 &&
        file.lastChangedAt !== null &&
        !isTestPath(file.path),
    )
    .map((file) => ({ file, timestamp: Date.parse(file.lastChangedAt) }))
    .filter((entry) => !Number.isNaN(entry.timestamp))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        compareText(left.file.path, right.file.path),
    )
    .slice(0, Math.max(0, limit))
    .map(({ file }) => ({
      fileId: file.fileId,
      path: file.path,
      lastChangedAt: file.lastChangedAt,
      lastAuthor: file.lastAuthor,
    }));

  return { files: fileEntries, contributors, hotspots, recent, commitCount: commits.length };
}

function detectOwnershipIntent(question) {
  const text = String(question ?? "");

  if (OWNERSHIP_INTENT.test(text)) return "owner";
  if (RECENCY_INTENT.test(text)) return "recency";

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

function shallowNote(shallow, commitCount) {
  if (!shallow) return "";

  return `\n\nThis clone only carries ${commitCount} ${
    commitCount === 1 ? "commit" : "commits"
  } of history, so ownership reflects only that much.`;
}

// Turns an ownership or recency question into a grounded answer. Returns null
// when the question is neither, letting the caller fall back to retrieval and
// the model.
function answerOwnershipQuestion({ question, intent, target, ownership, shallow = false }) {
  const resolvedIntent = intent ?? detectOwnershipIntent(question);

  if (!resolvedIntent) return null;

  if (ownership.commitCount === 0) {
    return "I could not read any git history for this repository, so I cannot say who has touched it or what changed recently. The clone may be missing its `.git` folder.";
  }

  const note = shallowNote(shallow, ownership.commitCount);

  if (resolvedIntent === "owner") {
    if (target) {
      const file = ownership.files.find((entry) => entry.path === target);

      if (!file) return null;

      if (file.commitCount === 0) {
        return `\`${file.path}\` has no commits in the available history.${note}`;
      }

      return [
        `\`${file.path}\` has ${file.commitCount} ${
          file.commitCount === 1 ? "commit" : "commits"
        }. The most likely ${
          file.authors.length === 1 ? "reviewer is" : "reviewers are"
        }:`,
        "",
        ...bulletList(
          file.authors.map(
            (author) =>
              `\`${author.name}\` (${author.count} ${
                author.count === 1 ? "commit" : "commits"
              }, last ${shortDate(author.lastChangedAt)})`,
          ),
        ),
      ].join("\n") + note;
    }

    if (ownership.contributors.length === 0) return null;

    return [
      "The people who have changed this repository most are:",
      "",
      ...bulletList(
        ownership.contributors.map(
          (contributor) =>
            `\`${contributor.name}\` (${contributor.commitCount} ${
              contributor.commitCount === 1 ? "commit" : "commits"
            }, ${contributor.fileCount} indexed ${
              contributor.fileCount === 1 ? "file" : "files"
            })`,
        ),
      ),
    ].join("\n") + note;
  }

  const lines = [
    `The indexed history covers ${ownership.commitCount} ${
      ownership.commitCount === 1 ? "commit" : "commits"
    }.`,
  ];

  if (ownership.hotspots.length > 0) {
    lines.push(
      "",
      "Most frequently changed:",
      "",
      ...bulletList(
        ownership.hotspots.map(
          (file) =>
            `\`${file.path}\` (${file.commitCount} ${
              file.commitCount === 1 ? "commit" : "commits"
            })`,
        ),
      ),
    );
  }

  if (ownership.recent.length > 0) {
    lines.push(
      "",
      "Most recently changed:",
      "",
      ...bulletList(
        ownership.recent.map(
          (file) =>
            `\`${file.path}\` (${shortDate(file.lastChangedAt)}${
              file.lastAuthor?.name ? `, ${file.lastAuthor.name}` : ""
            })`,
        ),
      ),
    );
  }

  return lines.join("\n") + note;
}

function tryDeepenHistory(git, rootPath) {
  const existing = deepenAttempts.get(rootPath);

  if (existing) return existing;

  const attempt = (async () => {
    try {
      await git.raw([
        "fetch",
        `--deepen=${DEEPEN_COMMITS}`,
        "--quiet",
        "--no-tags",
      ]);
      return true;
    } catch {
      // Offline, no remote, or a repository git cannot reach: whatever history
      // is already present is still worth reporting.
      return false;
    }
  })();

  deepenAttempts.set(rootPath, attempt);

  return attempt;
}

async function isShallowRepository(git) {
  const result = await git.raw(["rev-parse", "--is-shallow-repository"]);
  return result.trim() === "true";
}

// Reads the clone's history, deepening a shallow clone once so churn is more
// than the single commit the app cloned.
async function readGitHistory(
  rootPath,
  { timeoutMs = GIT_TIMEOUT_MS, maxCommits = HISTORY_MAX_COMMITS, deepen = true } = {},
) {
  if (!rootPath) return { commits: [], shallow: false };

  const git = simpleGit({ baseDir: rootPath, timeout: { block: timeoutMs } });
  let shallow;

  try {
    shallow = await isShallowRepository(git);
  } catch {
    // Not a git repository (for example an `index-repo` path outside a clone).
    return { commits: [], shallow: false };
  }

  if (shallow && deepen && (await tryDeepenHistory(git, rootPath))) {
    try {
      shallow = await isShallowRepository(git);
    } catch {
      // Keep the pre-fetch answer; the log below still reads what is there.
    }
  }

  let raw = "";

  try {
    raw = await git.raw([
      "log",
      "--no-merges",
      `--max-count=${maxCommits}`,
      "--name-only",
      `--pretty=format:${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%aI`,
    ]);
  } catch {
    raw = "";
  }

  return { commits: parseGitLog(raw), shallow };
}

const EMPTY_OWNERSHIP = {
  files: [],
  contributors: [],
  hotspots: [],
  recent: [],
  file: null,
  commitCount: 0,
  shallow: false,
};

// The Explorer's ownership view: every indexed path for the picker, the
// repository-wide churn and recency lists, and (when a file is chosen) the
// authors who have touched it most.
async function getOwnership(repositoryId, filePath, options = {}) {
  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return { ...EMPTY_OWNERSHIP };

  const db = getDb();
  const fileRows = db
    .prepare("SELECT id, path FROM files WHERE repo_id = ? ORDER BY path")
    .all(repoId);
  const repo = db
    .prepare("SELECT root_path FROM repos WHERE id = ?")
    .get(repoId);
  const { commits, shallow } = await readGitHistory(repo?.root_path, options);
  const ownership = buildOwnership({ files: fileRows, commits, limit: options.limit });
  const target = filePath ? toPosix(filePath) : "";

  return {
    files: fileRows.map((file) => ({ id: file.id, path: toPosix(file.path) })),
    contributors: ownership.contributors,
    hotspots: ownership.hotspots,
    recent: ownership.recent,
    file: target
      ? ownership.files.find((entry) => entry.path === target) ?? null
      : null,
    commitCount: ownership.commitCount,
    shallow,
  };
}

// The chat path. Reuses the same target resolution as impact so a question that
// names a file resolves the file, and falls back to the contributor ranking
// when the question asks about the repository as a whole.
async function answerRepositoryOwnershipQuestion(repositoryId, question) {
  const intent = detectOwnershipIntent(question);

  if (!intent) return null;

  const repoId = findRepoPrimaryKey(repositoryId);

  if (repoId === null) return null;

  const db = getDb();
  const fileRows = db
    .prepare("SELECT id, path FROM files WHERE repo_id = ? ORDER BY path")
    .all(repoId);
  const repo = db
    .prepare("SELECT root_path FROM repos WHERE id = ?")
    .get(repoId);
  const { commits, shallow } = await readGitHistory(repo?.root_path);
  const ownership = buildOwnership({ files: fileRows, commits });

  if (ownership.commitCount === 0) {
    return "I could not read any git history for this repository, so I cannot say who has touched it or what changed recently. The clone may be missing its `.git` folder.";
  }

  let target = null;

  if (intent === "owner") {
    const resolved = resolveGraphTarget({ question, files: fileRows });

    target = resolved?.kind === "file" ? resolved.path : null;
  }

  return answerOwnershipQuestion({ question, intent, target, ownership, shallow });
}

module.exports = {
  answerOwnershipQuestion,
  answerRepositoryOwnershipQuestion,
  buildOwnership,
  detectOwnershipIntent,
  getOwnership,
  parseGitLog,
};
