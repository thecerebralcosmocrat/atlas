// Heuristic symbol and import extraction, one small extractor per language.
//
// This is deliberately a dispatch table rather than a parser. Each entry owns
// one language family and returns the same record shapes, so a future
// tree-sitter implementation can replace a single entry without the indexer or
// the graph query knowing. Unknown languages yield empty results instead of an
// error: a file we cannot parse must not fail an index.

const JAVASCRIPT_LANGUAGES = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const PYTHON_LANGUAGES = ["py"];

const LANGUAGE_GROUPS = new Map();
for (const language of JAVASCRIPT_LANGUAGES) {
  LANGUAGE_GROUPS.set(language, "javascript");
}
for (const language of PYTHON_LANGUAGES) {
  LANGUAGE_GROUPS.set(language, "python");
}

const MAX_SIGNATURE_LENGTH = 200;
const MAX_BLOCK_SCAN_LINES = 60;

function normalizeLanguage(language) {
  return String(language ?? "").replace(/^\./, "").toLowerCase();
}

function splitLines(rawContent) {
  return String(rawContent ?? "").split(/\r?\n/);
}

function leadingIndent(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function truncateSignature(line) {
  const trimmed = line.trim();

  return trimmed.length > MAX_SIGNATURE_LENGTH
    ? trimmed.slice(0, MAX_SIGNATURE_LENGTH)
    : trimmed;
}

// Blanks out string literals and line comments so braces inside them cannot
// confuse block matching. Regex literals and block comments are left alone;
// this is a heuristic, not a tokenizer.
function stripLineNoise(line) {
  let result = "";
  let quote = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "/" && line[index + 1] === "/") break;

    result += char;
  }

  return result;
}

// Returns the 0-based line where the brace block opened on (or shortly after)
// `startIndex` closes, or `startIndex` when there is no block.
function findBraceBlockEnd(lines, startIndex) {
  const limit = Math.min(lines.length, startIndex + MAX_BLOCK_SCAN_LINES);
  let depth = 0;
  let opened = false;

  for (let index = startIndex; index < limit; index += 1) {
    for (const char of stripLineNoise(lines[index])) {
      if (char === "{") {
        depth += 1;
        opened = true;
      } else if (char === "}") {
        if (depth > 0) depth -= 1;

        if (opened && depth === 0) return index;
      }
    }
  }

  // No closing brace in range: the block either runs long or is malformed.
  // Ending at the last scanned line beats claiming the whole file.
  return opened ? limit - 1 : startIndex;
}

const JS_BINDING_PREFIX =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/;

// Returns the index of the `)` that closes the `(` at `startIndex`, ignoring
// parens inside string literals, or -1 when the group never closes.
function findBalancedParenEnd(text, startIndex) {
  let depth = 0;
  let quote = null;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;

      if (depth === 0) return index;
    }
  }

  return -1;
}

// Drops a leading `async` only when it modifies the function that follows.
// `async (a) => a`, `async(a) => a`, `async a => a`, and `async function () {}`
// are all async functions, but `async => a` is a plain arrow whose parameter
// happens to be named `async`, and `async;`/`asyncFn()` merely start with the
// letters.
function stripAsyncKeyword(text) {
  if (!/^async(?=\s|\()/.test(text)) return text;

  const rest = text.slice("async".length).replace(/^\s+/, "");

  if (
    rest.startsWith("(") ||
    /^function\b/.test(rest) ||
    /^[A-Za-z_$][\w$]*\s*=>/.test(rest)
  ) {
    return rest;
  }

  return text;
}

// A `const|let|var` binding is callable when its initializer *is* an arrow or
// function expression. Testing that with a regex is unreliable — `(a + b) * c`
// and `(a) && list.some((x) => x)` both contain parens and an arrow — so the
// parameter list is consumed as one balanced group and only a `=>` immediately
// after it counts.
function matchFunctionBinding(line) {
  const prefix = JS_BINDING_PREFIX.exec(line);

  if (!prefix) return null;

  // `async` binds to the function, not to an identifier: `async (a) => a`.
  const rest = stripAsyncKeyword(line.slice(prefix[0].length));

  if (/^function\b/.test(rest)) return prefix[1];

  if (rest.startsWith("(")) {
    const end = findBalancedParenEnd(rest, 0);

    if (end === -1) return null;

    // A TypeScript return annotation may sit between `)` and `=>`.
    return /^\s*(?::[^=;]*?)?=>/.test(rest.slice(end + 1)) ? prefix[1] : null;
  }

  return /^[A-Za-z_$][\w$]*\s*=>/.test(rest) ? prefix[1] : null;
}

const JS_PATTERNS = [
  {
    kind: "function",
    regex:
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/,
    block: true,
  },
  {
    kind: "class",
    regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    block: true,
  },
  {
    kind: "enum",
    regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    block: true,
  },
  {
    kind: "interface",
    regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    block: true,
  },
  {
    kind: "type",
    regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
    block: true,
  },
  {
    // Arrow and function-expression bindings, matched by helper rather than a
    // regex so nested parens in the parameter list are balanced correctly.
    kind: "function",
    match: matchFunctionBinding,
    block: true,
  },
  {
    kind: "variable",
    regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    block: false,
  },
];

function extractJavaScriptSymbols(lines) {
  const symbols = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const pattern of JS_PATTERNS) {
      let name;

      if (pattern.match) {
        name = pattern.match(line);

        if (name === null) continue;
      } else {
        const match = pattern.regex.exec(line);

        if (!match) continue;

        name = match[1] || "default";
      }

      const lineEnd = pattern.block
        ? findBraceBlockEnd(lines, index) + 1
        : index + 1;

      symbols.push({
        name,
        kind: pattern.kind,
        signature: truncateSignature(line),
        lineStart: index + 1,
        lineEnd,
        isExported: /^\s*export\s/.test(line),
      });
      break;
    }
  }

  return symbols;
}

// Import statements can span lines (`import {\n  a,\n} from "x"`), so matches
// run over the whole source rather than one line at a time. The statement
// regexes keep `^` anchored per line via the `m` flag.
function collectMatches(sourceText, regex, type) {
  const imports = [];
  const source = String(sourceText ?? "");

  regex.lastIndex = 0;
  let match = regex.exec(source);

  while (match) {
    imports.push({ specifier: match[1], type });
    match = regex.exec(source);
  }

  return imports;
}

function extractJavaScriptImports(sourceText) {
  const imports = [
    // `import x from "y"`, `import { a } from "y"`, `import "y"`.
    ...collectMatches(
      sourceText,
      /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
      "import",
    ),
    // `export { a } from "y"` re-exports the dependency.
    ...collectMatches(
      sourceText,
      /^\s*export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm,
      "export",
    ),
    // CommonJS and dynamic imports can appear anywhere, including split across
    // lines (`import(\n  "x"\n)`).
    ...collectMatches(
      sourceText,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      "require",
    ),
    ...collectMatches(
      sourceText,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      "dynamic",
    ),
  ];

  return dedupeImports(imports);
}

// Python blocks end where indentation returns to the declaration's level.
function findPythonBlockEnd(lines, startIndex, indent) {
  let end = startIndex;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) continue;

    if (leadingIndent(line) <= indent) break;

    end = index;
  }

  return end;
}

const PYTHON_SYMBOL_PATTERNS = [
  {
    kind: "function",
    regex: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  },
  {
    kind: "class",
    regex: /^(\s*)class\s+([A-Za-z_]\w*)/,
  },
];

function extractPythonSymbols(lines) {
  const symbols = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const pattern of PYTHON_SYMBOL_PATTERNS) {
      const match = pattern.regex.exec(line);

      if (!match) continue;

      const indent = match[1].length;
      const name = match[2];

      symbols.push({
        name,
        kind: pattern.kind,
        signature: truncateSignature(line),
        lineStart: index + 1,
        lineEnd: findPythonBlockEnd(lines, index, indent) + 1,
        // Python has no export keyword; the leading-underscore convention is
        // the closest thing to a private marker.
        isExported: !name.startsWith("_"),
      });
      break;
    }
  }

  return symbols;
}

function extractPythonImports(sourceText) {
  const imports = [];

  for (const line of splitLines(sourceText)) {
    // `import a, b as c`
    const plain = /^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)/.exec(
      line,
    );

    if (plain) {
      for (const part of plain[1].split(",")) {
        const moduleName = part.trim().split(/\s+as\s+/)[0];

        if (moduleName) imports.push({ specifier: moduleName, type: "import" });
      }

      continue;
    }

    // `from .pkg.mod import name`
    const fromImport = /^\s*from\s+([.\w]+)\s+import\s+/.exec(line);

    if (fromImport) {
      imports.push({ specifier: fromImport[1], type: "import" });
    }
  }

  return dedupeImports(imports);
}

function dedupeImports(imports) {
  const seen = new Set();
  const unique = [];

  for (const entry of imports) {
    const key = `${entry.type}:${entry.specifier}`;

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

const EXTRACTORS = {
  javascript: {
    extractSymbols: extractJavaScriptSymbols,
    extractImports: extractJavaScriptImports,
  },
  python: {
    extractSymbols: extractPythonSymbols,
    extractImports: extractPythonImports,
  },
};

// The one entry point the indexer uses. Returns symbols and imports for a file,
// or empty arrays when the language has no extractor.
function extractFileSymbols({ language, rawContent }) {
  const group = LANGUAGE_GROUPS.get(normalizeLanguage(language));
  const extractor = group ? EXTRACTORS[group] : null;

  if (!extractor) {
    return { symbols: [], imports: [] };
  }

  const lines = splitLines(rawContent);

  return {
    symbols: extractor.extractSymbols(lines),
    imports: extractor.extractImports(rawContent),
  };
}

module.exports = {
  extractFileSymbols,
  normalizeLanguage,
};
