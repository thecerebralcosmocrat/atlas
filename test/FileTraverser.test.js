const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileTraverser } = require("../electron/indexer/FileTraverser");

function writeFixtureFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-traverse-"));

  writeFixtureFile(root, "src/index.js", "const a = 1;\n\nconst b = 2;\n");
  writeFixtureFile(root, "src/app.jsx", "export default function App() {}\n");
  writeFixtureFile(root, "script.py", "print('hi')\n");

  // Should be excluded: disallowed extension.
  writeFixtureFile(root, "README.md", "# readme\n");
  writeFixtureFile(root, "styles.css", "body {}\n");

  // Should be excluded: skipped directory.
  writeFixtureFile(root, "node_modules/dep/index.js", "module.exports = 1;\n");
  writeFixtureFile(root, "dist/bundle.js", "!function () {};\n");

  // Should be excluded: skipped suffix.
  writeFixtureFile(root, "app.min.js", "!function () {};\n");

  // Should be excluded: over the 500 KB size cap.
  writeFixtureFile(root, "big.js", "a".repeat(600 * 1024));

  return root;
}

function toRelativeSet(files) {
  return new Set(files.map((file) => file.path.split(path.sep).join("/")));
}

test("collects only in-scope source files", async () => {
  const files = await new FileTraverser().traverse(makeFixtureRepo());

  assert.deepStrictEqual(
    toRelativeSet(files),
    new Set(["src/index.js", "src/app.jsx", "script.py"]),
  );
});

test("collects C# and other newly allowed source files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-traverse-langs-"));
  const extensions = [
    "cs",
    "rb",
    "php",
    "swift",
    "kt",
    "kts",
    "scala",
    "sh",
    "sql",
  ];

  for (const extension of extensions) {
    writeFixtureFile(root, `src/file.${extension}`, "content\n");
  }

  const files = await new FileTraverser().traverse(root);

  assert.deepStrictEqual(
    toRelativeSet(files),
    new Set(extensions.map((extension) => `src/file.${extension}`)),
  );
});

test("counts non-empty lines as loc", async () => {
  const files = await new FileTraverser().traverse(makeFixtureRepo());
  const indexFile = files.find((file) => file.path.endsWith("index.js"));

  assert.strictEqual(indexFile.loc, 2);
});

test("returns absolute paths alongside relative paths", async () => {
  const root = makeFixtureRepo();
  const files = await new FileTraverser().traverse(root);

  for (const file of files) {
    assert.ok(path.isAbsolute(file.absPath));
    assert.strictEqual(file.absPath, path.join(root, file.path));
  }
});
