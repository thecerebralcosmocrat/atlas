const test = require("node:test");
const assert = require("node:assert");

const {
  encodeVector,
  decodeVector,
  dotProduct,
  cosineSimilarity,
} = require("../electron/query/vectors");

test("a vector survives the round trip through a SQLite blob", () => {
  const vector = [0.5, -1.25, 3, 0];

  assert.deepStrictEqual([...decodeVector(encodeVector(vector))], vector);
});

test("decodes a blob that starts at an unaligned offset", () => {
  // SQLite hands back a Buffer that can sit anywhere inside a shared pool, and
  // a Float32Array view requires 4-byte alignment. A three-byte prefix puts the
  // vector at offset 3, which would throw if the bytes were viewed in place.
  const pooled = Buffer.concat([Buffer.from([1, 2, 3]), encodeVector([1, 2])]);

  assert.deepStrictEqual([...decodeVector(pooled.subarray(3))], [1, 2]);
});

test("scores identical vectors as 1 and unrelated ones as 0", () => {
  assert.strictEqual(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.strictEqual(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("normalizes, so magnitude alone does not change the score", () => {
  assert.strictEqual(cosineSimilarity([3, 4], [6, 8]), 1);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [3, 4]) - 0.6) < 1e-9);
});

test("scores a zero vector as 0 instead of dividing by zero", () => {
  assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.strictEqual(cosineSimilarity([1, 1], [0, 0]), 0);
});

test("scores vectors from different models as 0 rather than a guess", () => {
  // A dimension mismatch means the two vectors live in different spaces, so
  // comparing their shared prefix would rank unrelated chunks.
  assert.strictEqual(cosineSimilarity([1, 0, 0], [1, 0]), 0);
});

test("dotProduct multiplies pairwise and sums", () => {
  assert.strictEqual(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  assert.strictEqual(dotProduct([], []), 0);
});
