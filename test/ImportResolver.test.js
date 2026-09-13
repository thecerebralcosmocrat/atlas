const test = require("node:test");
const assert = require("node:assert");

const {
  createImportResolver,
  toPosix,
} = require("../electron/indexer/ImportResolver");

// Paths use Windows separators on purpose: the indexer stores what the OS gave
// it, so the resolver has to normalize before matching.
const JAVASCRIPT_FILES = [
  "src\\index.js",
  "src\\util.ts",
  "src\\components\\Button.jsx",
  "src\\components\\index.js",
];

function jsResolver() {
  return createImportResolver(JAVASCRIPT_FILES);
}

test("toPosix normalizes Windows separators", () => {
  assert.strictEqual(toPosix("src\\components\\Button.jsx"), "src/components/Button.jsx");
  assert.strictEqual(toPosix("src/index.js"), "src/index.js");
});

test("resolves a relative import to the indexed file's original path", () => {
  assert.strictEqual(jsResolver().resolve("src\\index.js", "./util"), "src\\util.ts");
});

test("resolves a nested relative import", () => {
  assert.strictEqual(
    jsResolver().resolve("src\\index.js", "./components/Button"),
    "src\\components\\Button.jsx",
  );
});

test("resolves a directory import to its index file", () => {
  assert.strictEqual(
    jsResolver().resolve("src\\index.js", "./components"),
    "src\\components\\index.js",
  );
});

test("maps a .js specifier onto a TypeScript source file", () => {
  // TypeScript ESM writes "./util.js" even though the file on disk is util.ts.
  assert.strictEqual(
    jsResolver().resolve("src\\index.ts", "./util.js"),
    "src\\util.ts",
  );
});

test("treats a bare package specifier as external", () => {
  assert.strictEqual(jsResolver().resolve("src\\index.js", "react"), null);
  assert.strictEqual(jsResolver().resolve("src\\index.js", "@scope/pkg"), null);
});

test("returns null for an import that points outside the index", () => {
  assert.strictEqual(jsResolver().resolve("src\\index.js", "./missing"), null);
});

test("resolves Python relative imports across dotted packages", () => {
  const resolver = createImportResolver([
    "pkg\\__init__.py",
    "pkg\\mod.py",
    "pkg\\sub\\other.py",
  ]);

  assert.strictEqual(resolver.resolve("pkg\\sub\\other.py", "..mod"), "pkg\\mod.py");
  assert.strictEqual(
    resolver.resolve("pkg\\mod.py", ".sub.other"),
    "pkg\\sub\\other.py",
  );
  // A bare "." means the package's own __init__.py.
  assert.strictEqual(resolver.resolve("pkg\\mod.py", "."), "pkg\\__init__.py");
});

test("ignores empty specifiers", () => {
  assert.strictEqual(jsResolver().resolve("src\\index.js", ""), null);
  assert.strictEqual(jsResolver().resolve("src\\index.js", null), null);
});
