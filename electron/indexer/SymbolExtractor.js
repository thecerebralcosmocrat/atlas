// Heuristic symbol and import extraction, one small extractor per language.
//
// This is deliberately a dispatch table rather than a parser. Each entry owns
// one language family and returns the same record shapes, so a future
// tree-sitter implementation can replace a single entry without the indexer or
// the graph query knowing. Unknown languages yield empty results instead of an
// error: a file we cannot parse must not fail an index.

const JAVASCRIPT_LANGUAGES = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const PYTHON_LANGUAGES = ["py"];
// C and C++ share one extractor. Header extensions are included so a
// repository's public API shows up in the graph even with no .c/.cpp file.
const C_LANGUAGES = [
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "c++",
  "hh",
  "hpp",
  "hxx",
  "inl",
  "ipp",
  "tpp",
];

const LANGUAGE_GROUPS = new Map();
for (const language of JAVASCRIPT_LANGUAGES) {
  LANGUAGE_GROUPS.set(language, "javascript");
}
for (const language of PYTHON_LANGUAGES) {
  LANGUAGE_GROUPS.set(language, "python");
}
for (const language of C_LANGUAGES) {
  LANGUAGE_GROUPS.set(language, "c");
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

// C and C++ are parsed by line-oriented heuristics, like the other languages.
// The scanner blanks comments and string/char literals before matching, so
// braces in comments and format strings cannot throw off block ranges.
const C_MAX_DECLARATION_SCAN_LINES = 40;
const C_MAX_BLOCK_SCAN_LINES = 5000;

const C_STATEMENT_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "goto",
  "return",
  "sizeof",
  "alignof",
  "decltype",
  "static_assert",
  "throw",
  "new",
  "delete",
  "using",
  "typedef",
  "namespace",
  "public",
  "private",
  "protected",
  "co_return",
  "co_await",
  "co_yield",
]);

// Replaces comments and the contents of string/char literals with spaces while
// preserving one output line per input line. Multiline block comments keep
// their line count, so line ranges still point at the original source.
function stripCCommentsAndStrings(lines) {
  const stripped = [];
  let inBlockComment = false;

  for (const line of lines) {
    let result = "";
    let quote = null;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];

      if (inBlockComment) {
        if (char === "*" && line[index + 1] === "/") {
          inBlockComment = false;
          index += 1;
          result += "  ";
        } else {
          result += " ";
        }

        continue;
      }

      if (quote) {
        if (char === "\\") {
          index += 1;
          result += "  ";
        } else {
          if (char === quote) quote = null;
          result += " ";
        }

        continue;
      }

      if (char === "/" && line[index + 1] === "/") break;

      if (char === "/" && line[index + 1] === "*") {
        inBlockComment = true;
        index += 1;
        result += "  ";
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        result += " ";
        continue;
      }

      result += char;
    }

    stripped.push(result);
  }

  return stripped;
}

function findCBlockEnd(lines, startIndex) {
  const limit = Math.min(lines.length, startIndex + C_MAX_BLOCK_SCAN_LINES);
  let depth = 0;
  let opened = false;

  for (let index = startIndex; index < limit; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") {
        depth += 1;
        opened = true;
      } else if (char === "}") {
        if (depth > 0) depth -= 1;

        if (opened && depth === 0) return index;
      }
    }
  }

  return opened ? limit - 1 : startIndex;
}

// Finds the `{` that opens a function body or the `;` that ends a prototype,
// ignoring parentheses (and therefore default arguments) along the way.
function findCDeclarationEnd(lines, startIndex) {
  const limit = Math.min(
    lines.length,
    startIndex + C_MAX_DECLARATION_SCAN_LINES,
  );
  let depth = 0;
  let sawParen = false;

  for (let index = startIndex; index < limit; index += 1) {
    for (const char of lines[index]) {
      if (char === "(") {
        depth += 1;
        sawParen = true;
        continue;
      }

      if (char === ")") {
        if (depth > 0) depth -= 1;
        continue;
      }

      if (!sawParen || depth > 0) continue;

      if (char === "{") return { kind: "block", lineIndex: index };
      if (char === ";") return { kind: "declaration", lineIndex: index };
    }
  }

  return null;
}

function isCTypePrefix(prefix) {
  const trimmed = prefix.trim();

  if (!trimmed) return false;
  // A return type never contains these; seeing one means this is an
  // expression (assignment, arithmetic, a call) rather than a declaration.
  if (/[=+\-%!?|^;{}()]/.test(trimmed)) return false;
  // A `::` chain belonging to the function name must not be split off as the
  // return type (`Widget::operator bool`), and `std::move(x)` is a call.
  if (/:$/.test(trimmed)) return false;

  const firstWord = /^[A-Za-z_]\w*/.exec(trimmed)?.[0];

  return firstWord === undefined || !C_STATEMENT_KEYWORDS.has(firstWord);
}

// Out-of-line constructors and destructors have no return type, so they are
// matched separately. Requiring the owner to match the final segment rejects
// ordinary calls such as `std::move(x)`.
function isConstructorLike(name) {
  const parts = name.split("::");

  if (parts.length < 2) return false;

  return (
    parts[parts.length - 2] === parts[parts.length - 1].replace(/^~/, "")
  );
}

const C_OPERATOR_FUNCTION =
  /^\s*([A-Za-z_][\w:<>,\[\]\s*&]*?)\s+((?:[A-Za-z_]\w*::)*operator\s*[^\s(]+)\s*\(/;
const C_QUALIFIED_OPERATOR =
  /^\s*((?:[A-Za-z_]\w*::)*operator\s*[^\s(]+)\s*\(/;
const C_QUALIFIED_FUNCTION =
  /^\s*(?:template\s*<[^>]*>\s*)?(?:explicit\s+)?([A-Za-z_]\w*(?:::[A-Za-z_~]\w*)+)\s*\(/;
// The return type and the name must be separated by whitespace, which keeps
// namespace-qualified calls such as `std::move(x)` from looking like a
// declaration with `s` as the return type.
const C_GENERAL_FUNCTION =
  /^\s*([A-Za-z_][\w:<>,\[\]\s*&]*?)\s+(?:[*&]+\s*)?([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)*)\s*\(/;

function matchCFunction(line) {
  const operatorWithType = C_OPERATOR_FUNCTION.exec(line);

  if (operatorWithType && isCTypePrefix(operatorWithType[1])) {
    return operatorWithType[2].replace(/\s+/g, " ");
  }

  const qualifiedOperator = C_QUALIFIED_OPERATOR.exec(line);

  if (qualifiedOperator) return qualifiedOperator[1].replace(/\s+/g, " ");

  const qualified = C_QUALIFIED_FUNCTION.exec(line);

  if (qualified && isConstructorLike(qualified[1])) return qualified[1];

  const general = C_GENERAL_FUNCTION.exec(line);

  if (!general || !isCTypePrefix(general[1])) return null;
  if (C_STATEMENT_KEYWORDS.has(general[2])) return null;

  return general[2];
}

const C_CONTAINER_PATTERNS = [
  {
    kind: "class",
    regex:
      /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?class\s+([A-Za-z_]\w*)/,
  },
  {
    kind: "struct",
    regex:
      /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/,
  },
  {
    kind: "union",
    regex:
      /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?union\s+([A-Za-z_]\w*)/,
  },
  {
    kind: "enum",
    regex:
      /^\s*(?:typedef\s+)?enum(?:\s+class|\s+struct)?\s+([A-Za-z_]\w*)/,
  },
  {
    kind: "namespace",
    regex: /^\s*(?:inline\s+)?namespace\s+([A-Za-z_]\w*)/,
  },
];

// `struct Foo *makeFoo(void)` starts with a container keyword but is a
// function. A `(` before the first `{` or `;` after the name means this is a
// declaration with a type specifier, not a definition of the container.
function matchCContainer(line) {
  for (const pattern of C_CONTAINER_PATTERNS) {
    const match = pattern.regex.exec(line);

    if (!match) continue;

    const rest = line.slice(match[0].length);
    const paren = rest.indexOf("(");
    const brace = rest.indexOf("{");
    const semicolon = rest.indexOf(";");

    if (
      paren !== -1 &&
      (brace === -1 || paren < brace) &&
      (semicolon === -1 || paren < semicolon)
    ) {
      return null;
    }

    return { name: match[1], kind: pattern.kind };
  }

  return null;
}

function findCTypedefEnd(lines, startIndex) {
  const limit = Math.min(lines.length, startIndex + C_MAX_DECLARATION_SCAN_LINES);

  for (let index = startIndex; index < limit; index += 1) {
    if (lines[index].includes(";")) return index;
  }

  return startIndex;
}

function matchCTypedef(lines, index) {
  const line = lines[index];
  const kindWord =
    /^\s*typedef\s+(?:enum\s+class|(?:struct|union|enum|class))\b/
      .exec(line)?.[0]
      .trim()
      .split(/\s+/)
      .pop() ?? null;
  let name = null;
  let kind = kindWord ?? "typedef";
  let lineEnd = index + 1;

  if (line.includes("{")) {
    const endIndex = findCBlockEnd(lines, index);
    const text = lines.slice(index, endIndex + 1).join("\n");
    const named = /^\s*typedef\s+(?:enum\s+class|(struct|union|enum|class))\s+([A-Za-z_]\w*)/.exec(
      line,
    );

    if (named) {
      kind = named[1] ?? "enum";
      name = named[2];
    } else {
      const afterBrace = text.slice(text.lastIndexOf("}") + 1);
      const alias = /^\s*(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)/.exec(
        afterBrace,
      );

      name = alias?.[1] ?? null;
    }

    lineEnd = endIndex + 1;
  } else {
    const endIndex = findCTypedefEnd(lines, index);
    const body = lines
      .slice(index, endIndex + 1)
      .join(" ")
      .replace(/^\s*typedef\b/, "")
      .replace(/;[\s\S]*$/, "");
    const functionPointer = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)/.exec(body);

    if (functionPointer) {
      name = functionPointer[1];
    } else {
      const identifiers =
        body.replace(/\[[^\]]*\]/g, " ").match(/[A-Za-z_]\w*/g) ?? [];

      name = identifiers[identifiers.length - 1] ?? null;
    }

    lineEnd = endIndex + 1;
  }

  if (!name) return null;

  return {
    name,
    kind,
    signature: truncateSignature(line),
    lineStart: index + 1,
    lineEnd,
    isExported: true,
  };
}

function extractCSymbols(lines) {
  const code = stripCCommentsAndStrings(lines);
  const symbols = [];

  for (let index = 0; index < code.length; index += 1) {
    const line = code[index];

    if (!line.trim()) continue;

    const defineMatch = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(line);

    if (defineMatch) {
      // Backslash-continued macros occupy every line through the last one
      // ending in a backslash.
      let lineEnd = index;

      while (
        lineEnd + 1 < lines.length &&
        /\\\s*$/.test(lines[lineEnd])
      ) {
        lineEnd += 1;
      }

      symbols.push({
        name: defineMatch[1],
        kind: "macro",
        signature: truncateSignature(lines[index]),
        lineStart: index + 1,
        lineEnd: lineEnd + 1,
        isExported: true,
      });
      continue;
    }

    if (/^\s*#/.test(line)) continue;

    if (/^\s*typedef\b/.test(line)) {
      const symbol = matchCTypedef(code, index);

      if (symbol) symbols.push(symbol);
      continue;
    }

    const container = matchCContainer(line);

    if (container) {
      const lineEnd = line.includes("{")
        ? findCBlockEnd(code, index) + 1
        : index + 1;

      symbols.push({
        name: container.name,
        kind: container.kind,
        signature: truncateSignature(lines[index]),
        lineStart: index + 1,
        lineEnd,
        isExported: !/^\s*static\b/.test(line),
      });
      continue;
    }

    if (!line.includes("(")) continue;

    const name = matchCFunction(line);

    if (!name) continue;

    const end = findCDeclarationEnd(code, index);

    if (!end) continue;

    const lineEnd =
      end.kind === "block"
        ? findCBlockEnd(code, end.lineIndex) + 1
        : end.lineIndex + 1;

    symbols.push({
      name,
      kind: "function",
      signature: truncateSignature(lines[index]),
      lineStart: index + 1,
      lineEnd,
      isExported: !/^\s*static\b/.test(line),
    });
  }

  return symbols;
}

function extractCImports(sourceText) {
  const imports = [];

  for (const line of splitLines(sourceText)) {
    const match = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(line);

    if (match) {
      // Angle brackets name system or third-party headers, which are resolved
      // outside the repository, so the resolver leaves them as external.
      imports.push({
        specifier: match[2].trim(),
        type: match[1] === "<" ? "system-include" : "include",
      });
    }
  }

  return dedupeImports(imports);
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
  c: {
    extractSymbols: extractCSymbols,
    extractImports: extractCImports,
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
