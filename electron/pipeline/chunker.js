// Splits an indexed file into the slices that get embedded.
//
// A chunk is a window of whole lines. Nothing is ever cut mid-line, so the
// start/end line a chunk reports always maps onto lines that exist in the file
// and an excerpt built from it can be cited back to the reader. Consecutive
// windows overlap, so a symbol that sits on a boundary still appears intact in
// at least one chunk.
//
// Pure: no database, no network, so the windowing is testable on its own.

const DEFAULT_OPTIONS = {
  // Roughly 40 lines is a screenful of code: enough context for a symbol and
  // its immediate callers, small enough that a handful of chunks fit in the
  // model's context alongside the question.
  maxLines: 40,
  // Enough to carry a symbol that straddles the previous window's end.
  overlapLines: 6,
  // A ceiling for files whose lines are long. The embedding model truncates
  // over-long input anyway, so a window bigger than this would silently lose
  // its tail rather than being covered by the next chunk.
  maxChars: 1600,
};

function splitLines(rawContent) {
  const lines = String(rawContent ?? "").split(/\r?\n/);

  // A file that ends with a newline splits into a trailing "" that is not a
  // real line. Dropping it keeps the final chunk's endLine equal to the file's
  // last line number instead of one past it.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function chunkFile(rawContent, options = {}) {
  const { maxLines, overlapLines, maxChars } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const lines = splitLines(rawContent);
  const chunks = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let chars = 0;

    while (end < lines.length && end - start < maxLines) {
      const lineChars = lines[end].length + (end > start ? 1 : 0);

      // The first line of a window is taken even when it alone exceeds the
      // budget, so a window always consumes at least one line and the loop
      // cannot stall on a file of very long lines.
      if (end > start && chars + lineChars > maxChars) break;

      chars += lineChars;
      end += 1;
    }

    const content = lines.slice(start, end).join("\n");

    // Whitespace-only windows carry no meaning to embed, so they are not
    // chunks at all rather than empty vectors.
    if (content.trim().length > 0) {
      chunks.push({
        ordinal: chunks.length,
        startLine: start + 1,
        endLine: end,
        content,
      });
    }

    if (end >= lines.length) break;

    // Step back by the overlap, but never further than the start of the window
    // just emitted: when the budget is smaller than the overlap, advancing by
    // the window end is what guarantees progress.
    const overlappedStart = end - overlapLines;
    start = overlappedStart > start ? overlappedStart : end;
  }

  return chunks;
}

// The text handed to the embedding model for a chunk. The path is prefixed
// because questions like "where is the router configured" match on filenames,
// which the chunk body alone does not carry. What gets stored and shown stays
// the bare code, so the path never leaks into a cited excerpt.
function chunkEmbedText(filePath, content) {
  return `${filePath}\n${content}`;
}

module.exports = { chunkFile, chunkEmbedText };
