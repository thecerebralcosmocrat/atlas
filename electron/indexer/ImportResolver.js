// Resolves an import specifier to another file in the same repository.
//
// Only files that were actually indexed can be a target, so the resolver is
// built from the set of repo-relative paths. Anything it cannot map is treated
// as external (a package, a builtin, a path outside the repo) rather than an
// error, so an unresolved import still produces a graph edge.

const pathPosix = require("path").posix;

const JAVASCRIPT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const PYTHON_EXTENSION = ".py";

function toPosix(filePath) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

// A relative JS/TS specifier: "./x", "../y", with or without an extension.
function resolveRelativeJavaScript(baseDir, specifier, byPath) {
  const target = pathPosix.normalize(pathPosix.join(baseDir, specifier));
  const candidates = [target];

  const extension = pathPosix.extname(target);

  if (extension) {
    // TypeScript ESM often imports "./foo.js" for a file that is actually
    // foo.ts, so try the same stem across every JS extension.
    const stem = target.slice(0, -extension.length);

    for (const candidateExtension of JAVASCRIPT_EXTENSIONS) {
      candidates.push(stem + candidateExtension);
    }
  } else {
    for (const candidateExtension of JAVASCRIPT_EXTENSIONS) {
      candidates.push(target + candidateExtension);
      candidates.push(`${target}/index${candidateExtension}`);
    }
  }

  return firstMatch(candidates, byPath);
}

// Python relative imports use dots: ".mod" is the current package, "..mod" the
// parent. One dot means the directory holding the importing module.
function resolveRelativePython(baseDir, specifier, byPath) {
  const match = /^(\.+)(.*)$/.exec(specifier);

  if (!match) return null;

  const [, dots, moduleName] = match;
  const ascents = dots.length - 1;
  let directory = baseDir;

  for (let index = 0; index < ascents; index += 1) {
    directory = pathPosix.normalize(pathPosix.join(directory, ".."));
  }

  const modulePath = moduleName.replace(/\./g, "/");
  const target = modulePath
    ? pathPosix.normalize(pathPosix.join(directory, modulePath))
    : directory;
  const candidates = modulePath
    ? [`${target}${PYTHON_EXTENSION}`, `${target}/__init__${PYTHON_EXTENSION}`]
    : [`${target}/__init__${PYTHON_EXTENSION}`];

  return firstMatch(candidates, byPath);
}

function firstMatch(candidates, byPath) {
  for (const candidate of candidates) {
    const original = byPath.get(candidate);

    if (original) return original;
  }

  return null;
}

// Builds a resolver bound to the repository's indexed files. `filePaths` may
// use either path separator; the original string is returned so callers can map
// back to database rows.
function createImportResolver(filePaths) {
  const byPath = new Map();

  for (const filePath of filePaths) {
    byPath.set(toPosix(filePath), filePath);
  }

  function resolve(sourcePath, specifier) {
    const normalizedSpecifier = String(specifier ?? "").trim();

    if (!normalizedSpecifier) return null;

    const source = toPosix(sourcePath);
    const baseDir = pathPosix.dirname(source);

    // "./x", "../x", ".x" and "..x" are all relative.
    if (!normalizedSpecifier.startsWith(".")) {
      return null;
    }

    if (
      normalizedSpecifier.startsWith("./") ||
      normalizedSpecifier.startsWith("../")
    ) {
      return resolveRelativeJavaScript(baseDir, normalizedSpecifier, byPath);
    }

    // A bare leading dot is Python's relative form.
    return resolveRelativePython(baseDir, normalizedSpecifier, byPath);
  }

  return { resolve };
}

module.exports = { createImportResolver, toPosix };
