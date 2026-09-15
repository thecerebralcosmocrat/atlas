const test = require("node:test");
const assert = require("node:assert");

const { chunkFile, chunkEmbedText } = require("../electron/pipeline/chunker");

function numberedLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(
    "\n",
  );
}

test("splits a file into whole-line windows with 1-based line numbers", () => {
  const chunks = chunkFile(numberedLines(100), {
    maxLines: 40,
    overlapLines: 0,
  });

  assert.deepStrictEqual(
    chunks.map((chunk) => [chunk.startLine, chunk.endLine]),
    [
      [1, 40],
      [41, 80],
      [81, 100],
    ],
  );
  assert.deepStrictEqual(
    chunks.map((chunk) => chunk.ordinal),
    [0, 1, 2],
  );
  assert.strictEqual(chunks[0].content.split("\n")[0], "line 1");
  assert.strictEqual(chunks[1].content.split("\n")[0], "line 41");
});

test("consecutive windows overlap so a symbol on a boundary stays whole", () => {
  const chunks = chunkFile(numberedLines(60), {
    maxLines: 40,
    overlapLines: 6,
  });

  // The second window steps back six lines, so anything straddling line 40 is
  // still intact in one of the two chunks.
  assert.strictEqual(chunks[1].startLine, 35);
  assert.strictEqual(chunks[1].endLine, 60);
});

test("never reports a line range past the end of the file", () => {
  const chunks = chunkFile("a\nb\nc\n", { maxLines: 40 });
  const last = chunks[chunks.length - 1];

  // The trailing newline starts no line, so the file has three lines, not four.
  assert.strictEqual(last.endLine, 3);
  assert.strictEqual(last.content, "a\nb\nc");
});

test("stops a window at the character budget", () => {
  const longLines = Array.from({ length: 10 }, (_, index) =>
    `${index}`.padEnd(100, "x"),
  ).join("\n");

  const chunks = chunkFile(longLines, {
    maxLines: 40,
    overlapLines: 0,
    maxChars: 250,
  });

  // Two 100-char lines plus a separator is 201 characters; a third would be
  // 302, over the 250 budget.
  assert.strictEqual(chunks[0].startLine, 1);
  assert.strictEqual(chunks[0].endLine, 2);
  assert.ok(chunks[0].content.length <= 250);
});

test("takes an over-long line rather than stalling on it", () => {
  const huge = "y".repeat(5000);
  const chunks = chunkFile(`${huge}\nshort\n`, {
    maxLines: 40,
    overlapLines: 0,
    maxChars: 100,
  });

  // A line that busts the budget alone still becomes a chunk, and the window
  // after it starts on the next line: the loop always makes progress.
  assert.deepStrictEqual(
    chunks.map((chunk) => [chunk.startLine, chunk.endLine]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.strictEqual(chunks[0].content, huge);
  assert.strictEqual(chunks[1].content, "short");
});

test("produces no chunks for content that is empty or only whitespace", () => {
  assert.deepStrictEqual(chunkFile(""), []);
  assert.deepStrictEqual(chunkFile("\n".repeat(50)), []);
});

test("keeps chunk content free of the file path", () => {
  const [chunk] = chunkFile("const x = 1;\n");

  assert.strictEqual(chunk.content, "const x = 1;");
  assert.strictEqual(
    chunkEmbedText("src/deep/path.js", chunk.content),
    "src/deep/path.js\nconst x = 1;",
  );
});
