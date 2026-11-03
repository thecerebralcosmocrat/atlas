// Files indexed so answers can quote them, but that are not source code: they
// have no symbols or imports, so the graph, entry-point and impact views leave
// them out instead of listing every README as an unused file.
const DOC_LANGUAGES = ["md", "mdx", "yml", "yaml", "toml"];

// SQL fragment for a `files` query that should only see source code. Safe to
// inline: the list above is a fixed constant, never user input.
const SOURCE_FILES_ONLY = `(language IS NULL OR language NOT IN (${DOC_LANGUAGES.map(
  (language) => `'${language}'`,
).join(", ")}))`;

module.exports = { DOC_LANGUAGES, SOURCE_FILES_ONLY };
