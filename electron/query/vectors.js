// Storage and scoring for chunk embeddings.
//
// Vectors live in SQLite as Float32 BLOBs — the same single source of truth as
// the rest of the index — and are ranked by brute force. For the thousands of
// chunks a repository of this size produces, a linear scan costs tens of
// milliseconds and buys a pure scoring function that needs no index to test, so
// a separate vector database would add a second store to keep in sync for no
// measurable gain.
//
// Pure: no database access, so the maths is testable directly.

function encodeVector(vector) {
  return Buffer.from(Float32Array.from(vector).buffer);
}

// SQLite returns a Buffer that can sit at any offset inside a shared pool, and
// a Float32Array view has to be 4-byte aligned. Copying the bytes out first
// guarantees the alignment instead of throwing on an unlucky row.
function decodeVector(blob) {
  const bytes = Buffer.from(blob);
  const copy = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  return new Float32Array(copy);
}

function dotProduct(left, right) {
  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * right[index];
  }

  return total;
}

function magnitude(vector) {
  return Math.sqrt(dotProduct(vector, vector));
}

// Cosine similarity, computed rather than assumed. The embedding model does
// return unit-length vectors, but ranking should not silently produce wrong
// orderings if that ever stops being true.
function cosineSimilarity(left, right) {
  // Vectors from different embedding models are not comparable. Scoring a
  // shared prefix would rank unrelated chunks, so a dimension mismatch is a
  // zero rather than a guess.
  if (left.length !== right.length) return 0;

  const leftNorm = magnitude(left);
  const rightNorm = magnitude(right);

  if (leftNorm === 0 || rightNorm === 0) return 0;

  return dotProduct(left, right) / (leftNorm * rightNorm);
}

module.exports = {
  encodeVector,
  decodeVector,
  dotProduct,
  cosineSimilarity,
};
