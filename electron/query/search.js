const { getDb } = require("../db/schema");

// Function words and generic repository vocabulary. Dropping these keeps a
// question like "where is the entry point?" focused on "entry point" rather
// than matching every file that happens to contain "the".
const STOPWORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be",
  "been", "being", "but", "by", "can", "code", "codebase", "could", "did",
  "do", "does", "doing", "done", "explain", "file", "files", "for", "from",
  "get", "give", "had", "has", "have", "he", "her", "here", "him", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "made",
  "make", "may", "me", "might", "mine", "must", "my", "need", "no", "not",
  "of", "on", "one", "onto", "or", "our", "out", "over", "please", "project",
  "repo", "repository", "she", "should", "show", "so", "some", "tell", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "to", "under", "up", "us", "use", "used", "using", "want", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

const DEFAULT_OPTIONS = {
  limit: 5,
  maxSnippetLines: 30,
  maxExcerptChars: 1200,
  maxTotalChars: 6000,
};

const PATH_MATCH_WEIGHT = 12;
const MAX_CONTENT_HITS_PER_TOKEN = 20;

// Splits a question into comparable terms: camelCase boundaries become spaces,
// everything is lowercased, and punctuation plus stopwords are dropped.
function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;

  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

function scoreFile(tokens, file) {
  const pathText = String(file.path ?? "").toLowerCase();
  const contentText = String(file.rawContent ?? "").toLowerCase();
  let score = 0;

  for (const token of tokens) {
    // A term in the path is a stronger signal than one buried in a file body.
    if (pathText.includes(token)) score += PATH_MATCH_WEIGHT;

    const hits = countOccurrences(contentText, token);
    if (hits > 0) score += Math.min(hits, MAX_CONTENT_HITS_PER_TOKEN);
  }

  return score;
}

function matchingLineIndices(lines, tokens) {
  const indices = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lowerLine = lines[index].toLowerCase();

    if (tokens.some((token) => lowerLine.includes(token))) {
      indices.push(index);
    }
  }

  return indices;
}

// Picks the window of `maxLines` consecutive lines containing the most query
// matches, so the excerpt is centered on the relevant code rather than the top
// of the file.
function bestWindow(lines, matchIndices, maxLines) {
  if (matchIndices.length === 0) {
    return { start: 0, end: Math.min(lines.length, maxLines) };
  }

  let bestStart = matchIndices[0];
  let bestCount = -1;
  let left = 0;

  for (let right = 0; right < matchIndices.length; right += 1) {
    while (matchIndices[right] - matchIndices[left] >= maxLines) {
      left += 1;
    }

    const count = right - left + 1;

    if (count > bestCount) {
      bestCount = count;
      bestStart = matchIndices[left];
    }
  }

  const start = Math.max(0, bestStart - 1);

  return { start, end: Math.min(lines.length, start + maxLines) };
}

function buildExcerpt(file, tokens, options) {
  const lines = String(file.rawContent ?? "").split(/\r?\n/);
  const matchIndices = matchingLineIndices(lines, tokens);
  const { start, end } = bestWindow(lines, matchIndices, options.maxSnippetLines);
  let content = lines.slice(start, end).join("\n");

  if (content.length > options.maxExcerptChars) {
    content = `${content.slice(0, options.maxExcerptChars)}\n…`;
  }

  return {
    path: file.path,
    language: file.language ?? "",
    startLine: start + 1,
    endLine: Math.min(end, lines.length),
    content,
    matched: matchIndices.length > 0,
  };
}

// Ranks in-memory file records against a question and returns the most relevant
// excerpts. Pure so it can be tested without a database.
function rankFiles(question, files, options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tokens = tokenize(question);

  if (tokens.length === 0 || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  const scored = files
    .map((file) => ({ file, score: scoreFile(tokens, file) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.file.path).localeCompare(String(b.file.path)),
    );

  const results = [];
  let totalChars = 0;

  for (const { file, score } of scored) {
    if (results.length >= resolved.limit) break;

    const excerpt = buildExcerpt(file, tokens, resolved);

    // Always keep at least one excerpt, then stop before the retrieved context
    // grows past what the model can usefully read.
    if (
      results.length > 0 &&
      totalChars + excerpt.content.length > resolved.maxTotalChars
    ) {
      break;
    }

    totalChars += excerpt.content.length;
    results.push({ ...excerpt, score });
  }

  return results;
}

// Reads the files indexed for a repository and ranks them against a question.
// Accepts either the renderer's external id or the numeric primary key.
function searchRepositoryFiles(repositoryId, question, options = {}) {
  if (repositoryId === undefined || repositoryId === null) return [];

  const selectColumns = `SELECT f.path, f.language, f.loc, f.raw_content AS rawContent
     FROM files f
     JOIN repos r ON r.id = f.repo_id`;
  const numericId = /^\d+$/.test(String(repositoryId))
    ? Number(repositoryId)
    : null;

  // External ids are the renderer's currency, so a match on one is authoritative.
  // Only fall back to the primary key when no external id matches, otherwise a
  // numeric-looking external id could union in a different repository's files.
  let rows = getDb()
    .prepare(`${selectColumns} WHERE r.external_id = ?`)
    .all(String(repositoryId));

  if (rows.length === 0 && numericId !== null) {
    rows = getDb()
      .prepare(`${selectColumns} WHERE r.id = ?`)
      .all(numericId);
  }

  return rankFiles(question, rows, options);
}

module.exports = {
  tokenize,
  rankFiles,
  searchRepositoryFiles,
};
