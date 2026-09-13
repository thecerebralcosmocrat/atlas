const test = require("node:test");
const assert = require("node:assert");

const {
  extractFileSymbols,
  normalizeLanguage,
} = require("../electron/indexer/SymbolExtractor");

function extract(language, lines) {
  return extractFileSymbols({ language, rawContent: lines.join("\n") });
}

test("extracts JS declarations with their kinds, exports, and line ranges", () => {
  const { symbols } = extract("js", [
    "export function alpha() {",
    "  return 1;",
    "}",
    "class Beta {}",
    "export const gamma = () => 2;",
    "const delta = 3;",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.isExported]),
    [
      ["alpha", "function", true],
      ["Beta", "class", false],
      ["gamma", "function", true],
      ["delta", "variable", false],
    ],
  );
  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.lineStart, symbol.lineEnd]),
    [
      [1, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ],
  );
});

test("extracts TypeScript-only declarations", () => {
  const { symbols } = extract("ts", [
    "export interface Foo {",
    "  a: number;",
    "}",
    "type Bar = string;",
    "enum Color { Red }",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["Foo", "interface"],
      ["Bar", "type"],
      ["Color", "enum"],
    ],
  );
  assert.strictEqual(symbols[0].isExported, true);
});

test("ignores braces inside strings when finding the end of a block", () => {
  const { symbols } = extract("js", [
    'function braces() {',
    '  return "}";',
    "}",
    "const after = 1;",
  ]);

  assert.strictEqual(symbols[0].name, "braces");
  assert.strictEqual(symbols[0].lineEnd, 3);
  assert.strictEqual(symbols[1].name, "after");
});

test("extracts Python defs and classes, ending blocks by indentation", () => {
  const { symbols } = extract("py", [
    "class Widget:",
    "    def render(self):",
    "        return 1",
    "",
    "    def _helper(self):",
    "        pass",
    "",
    "def top_level():",
    "    return 2",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.lineEnd]),
    [
      ["Widget", "class", 6],
      ["render", "function", 3],
      ["_helper", "function", 6],
      ["top_level", "function", 9],
    ],
  );
  // Python marks privacy with a leading underscore rather than an export keyword.
  assert.strictEqual(
    symbols.find((symbol) => symbol.name === "_helper").isExported,
    false,
  );
  assert.strictEqual(
    symbols.find((symbol) => symbol.name === "top_level").isExported,
    true,
  );
});

test("collects and dedupes every JS import form", () => {
  const { imports } = extract("js", [
    'import React from "react";',
    'import { useState } from "react";',
    'import "./styles.css";',
    'export { helper } from "./helper.js";',
    'const fs = require("fs");',
    'const lazy = await import("./lazy.js");',
  ]);

  assert.deepStrictEqual(imports, [
    { specifier: "react", type: "import" },
    { specifier: "./styles.css", type: "import" },
    { specifier: "./helper.js", type: "export" },
    { specifier: "fs", type: "require" },
    { specifier: "./lazy.js", type: "dynamic" },
  ]);
});

test("collects imports whose statement spans multiple lines", () => {
  const { imports } = extract("ts", [
    "import {",
    "  alpha,",
    "  beta,",
    '} from "./util";',
    "import type {",
    "  Thing,",
    '} from "types";',
    "const lazy = await import(",
    '  "./lazy"',
    ");",
  ]);

  assert.deepStrictEqual(imports, [
    { specifier: "./util", type: "import" },
    { specifier: "types", type: "import" },
    { specifier: "./lazy", type: "dynamic" },
  ]);
});

test("does not treat a parenthesized expression as a function binding", () => {
  const { symbols } = extract("js", [
    "const product = (a + b) * c;",
    "const tern = (a) ? b : c;",
    "const mapped = [1, 2].map((n) => n);",
    "const enabled = (count > 0) && list.some((item) => item.ready);",
    "const sum = (1 + 2) + arr.reduce((acc, v) => acc + v, 0);",
    "const double = (n) => n * 2;",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["product", "variable"],
      ["tern", "variable"],
      ["mapped", "variable"],
      ["enabled", "variable"],
      ["sum", "variable"],
      ["double", "function"],
    ],
  );
});

test("keeps arrow bindings whose parameter list contains nested parens", () => {
  const { symbols } = extract("js", [
    "const f = (a = foo()) => a;",
    "const g = ({ id = makeId() }) => id;",
    "const h = (a: number): number => a;",
    "const i = async (a) => a;",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["f", "function"],
      ["g", "function"],
      ["h", "function"],
      ["i", "function"],
    ],
  );
});

test("treats async functions as functions however async is spaced", () => {
  const { symbols } = extract("js", [
    "const spaced = async (a) => a;",
    "const tight = async(a) => a;",
    "const bare = async a => a;",
    "const defaults = async(a = foo()) => a;",
    "const expr = async function () {};",
    "const gen = async function* () {};",
    // `async` as a parameter name is an ordinary arrow, and as a binding name
    // it is an ordinary variable.
    "const paramNamed = async => async;",
    "const async = 1;",
  ]);

  assert.deepStrictEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["spaced", "function"],
      ["tight", "function"],
      ["bare", "function"],
      ["defaults", "function"],
      ["expr", "function"],
      ["gen", "function"],
      ["paramNamed", "function"],
      ["async", "variable"],
    ],
  );
});

test("collects Python plain and from-imports", () => {
  const { imports } = extract("py", [
    "import os, sys as system",
    "from .pkg.mod import thing",
    "from collections import OrderedDict",
  ]);

  assert.deepStrictEqual(imports, [
    { specifier: "os", type: "import" },
    { specifier: "sys", type: "import" },
    { specifier: ".pkg.mod", type: "import" },
    { specifier: "collections", type: "import" },
  ]);
});

test("returns empty results for a language with no extractor", () => {
  assert.deepStrictEqual(
    extractFileSymbols({ language: "go", rawContent: "package main" }),
    { symbols: [], imports: [] },
  );
});

test("normalizes a language name before dispatch", () => {
  assert.strictEqual(normalizeLanguage(".JS"), "js");
  assert.strictEqual(normalizeLanguage(""), "");
});
