const test = require("node:test");
const assert = require("node:assert");

const {
  createNimEmbedder,
  DEFAULT_EMBED_MODEL,
} = require("../electron/pipeline/embedder");

// Records every request so the tests can assert on batching and on the
// request body without touching the network.
function recordingFetch({ onRequest } = {}) {
  const requests = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    const request = { url, headers: init.headers, body };
    requests.push(request);

    if (onRequest) return onRequest(request, requests.length);

    return {
      ok: true,
      json: async () => ({
        data: body.input.map((_, index) => ({
          index,
          embedding: [index, index + 1],
        })),
      }),
    };
  };

  return { requests, impl };
}

test("returns null without an API key so callers fall back to lexical search", () => {
  assert.strictEqual(createNimEmbedder({}), null);
  assert.strictEqual(createNimEmbedder({ apiKey: "" }), null);
});

test("defaults to the NVIDIA NIM embedding endpoint and model", async () => {
  const { requests, impl } = recordingFetch();
  const embedder = createNimEmbedder({ apiKey: "k", fetchImpl: impl });

  assert.strictEqual(embedder.model, DEFAULT_EMBED_MODEL);

  await embedder.embedQuery("where is auth");

  assert.strictEqual(
    requests[0].url,
    "https://integrate.api.nvidia.com/v1/embeddings",
  );
  assert.strictEqual(requests[0].body.model, DEFAULT_EMBED_MODEL);
  assert.strictEqual(requests[0].headers.Authorization, "Bearer k");
});

test("labels passages and queries differently", async () => {
  // The model is asymmetric: the same text embedded as a passage and as a
  // query lands in different places, so each side has to declare itself.
  const { requests, impl } = recordingFetch();
  const embedder = createNimEmbedder({ apiKey: "k", fetchImpl: impl });

  await embedder.embedPassages(["a", "b"]);
  await embedder.embedQuery("c");

  assert.strictEqual(requests[0].body.input_type, "passage");
  assert.strictEqual(requests[1].body.input_type, "query");
});

test("sends the input as plain strings", async () => {
  // The service rejects objects here, so the vector has to come back mapped by
  // position rather than by echoing a structured input.
  const { requests, impl } = recordingFetch();
  await createNimEmbedder({ apiKey: "k", fetchImpl: impl }).embedPassages(["x"]);

  assert.deepStrictEqual(requests[0].body.input, ["x"]);
});

test("batches a large repository and keeps the vectors in input order", async () => {
  const { requests, impl } = recordingFetch();
  const embedder = createNimEmbedder({
    apiKey: "k",
    batchSize: 32,
    fetchImpl: impl,
  });
  const texts = Array.from({ length: 70 }, (_, index) => `chunk ${index}`);

  const vectors = await embedder.embedPassages(texts);

  assert.deepStrictEqual(
    requests.map((request) => request.body.input.length),
    [32, 32, 6],
  );
  assert.strictEqual(vectors.length, 70);

  // The fake returns [index, index + 1] per batch, so the first vector of each
  // batch is [0, 1]. They must arrive concatenated in request order, not
  // interleaved.
  assert.deepStrictEqual(vectors[0], [0, 1]);
  assert.deepStrictEqual(vectors[32], [0, 1]);
  assert.deepStrictEqual(vectors[69], [5, 6]);
});

test("orders vectors by the response's index rather than array order", async () => {
  const { impl } = recordingFetch({
    onRequest: (request) => ({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [7, 7] },
        ],
      }),
    }),
  });

  const vectors = await createNimEmbedder({
    apiKey: "k",
    fetchImpl: impl,
  }).embedPassages(["first", "second"]);

  assert.deepStrictEqual(vectors, [
    [7, 7],
    [9, 9],
  ]);
});

test("throws rather than misaligning vectors when a response is short", async () => {
  const { impl } = recordingFetch({
    onRequest: () => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
    }),
  });

  await assert.rejects(
    () =>
      createNimEmbedder({ apiKey: "k", fetchImpl: impl }).embedPassages([
        "a",
        "b",
      ]),
    /returned 1 vectors for 2 inputs/,
  );
});

test("throws when a response item carries no vector", async () => {
  // A full-length response is not proof of a usable one: an item without a
  // vector would be stored as `undefined` and only fail inside the indexer's
  // write transaction, losing the whole index instead of one vector.
  const items = [{ index: 0 }, { index: 0, embedding: null }, { index: 0, embedding: [] }];

  for (const item of items) {
    const { impl } = recordingFetch({
      onRequest: () => ({ ok: true, json: async () => ({ data: [item] }) }),
    });

    await assert.rejects(
      () =>
        createNimEmbedder({ apiKey: "k", fetchImpl: impl }).embedPassages(["a"]),
      /item 0 has no vector/,
    );
  }
});

test("throws when a vector entry is not a finite number", async () => {
  // An entry that is present but not a number encodes to a NaN BLOB: the right
  // count and the right shape, but a vector no score can ever be computed from.
  const entries = [
    ["a", "b"],
    [[1, 2], [3, 4]],
    [1, "x"],
    [1, NaN],
    [1, Infinity],
    [1, null],
    [1, undefined],
  ];

  for (const embedding of entries) {
    const { impl } = recordingFetch({
      onRequest: () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding }] }) }),
    });

    await assert.rejects(
      () =>
        createNimEmbedder({ apiKey: "k", fetchImpl: impl }).embedPassages(["a"]),
      /item 0 has a non-numeric entry/,
      `expected ${JSON.stringify(embedding)} to be rejected`,
    );
  }
});

test("accepts a dense numeric vector, including zeros", async () => {
  // The non-numeric check must not turn a legitimate all-zero or single-axis
  // vector into a failure: 0 is a finite number, not a missing entry.
  const { impl } = recordingFetch({
    onRequest: () => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0, -1.5, 0.25] }] }),
    }),
  });

  const vectors = await createNimEmbedder({
    apiKey: "k",
    fetchImpl: impl,
  }).embedPassages(["a"]);

  assert.deepStrictEqual(vectors, [[0, -1.5, 0.25]]);
});

test("reports the service's status when a request fails", async () => {
  const { impl } = recordingFetch({
    onRequest: () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }),
  });

  await assert.rejects(
    () => createNimEmbedder({ apiKey: "bad", fetchImpl: impl }).embedQuery("x"),
    /401 unauthorized/,
  );
});

test("makes no request when there is nothing to embed", async () => {
  const { requests, impl } = recordingFetch();

  assert.deepStrictEqual(
    await createNimEmbedder({ apiKey: "k", fetchImpl: impl }).embedPassages([]),
    [],
  );
  assert.strictEqual(requests.length, 0);
});

test("embedQuery resolves to a single vector", async () => {
  const { impl } = recordingFetch();
  const vector = await createNimEmbedder({
    apiKey: "k",
    fetchImpl: impl,
  }).embedQuery("how does auth work");

  assert.deepStrictEqual(vector, [0, 1]);
});
