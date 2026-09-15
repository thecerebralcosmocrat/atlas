// Embeds text through NVIDIA NIM's OpenAI-compatible /embeddings endpoint.
//
// Retrieval only works if the indexed text and the question are embedded the
// same way. These models are asymmetric: the same text embedded as a "query"
// and as a "passage" lands in different places (measured at ~0.76 cosine for
// identical text), so each side has to declare which one it is.
//
// `fetchImpl` is injectable so tests exercise batching and error handling
// without a network call or an API key.

const DEFAULT_EMBED_API_URL = "https://integrate.api.nvidia.com/v1/embeddings";
const DEFAULT_EMBED_MODEL = "nvidia/nemotron-3-embed-1b";
const DEFAULT_BATCH_SIZE = 32;

// Returns null when no key is configured. Callers treat that as "no semantic
// retrieval available" and fall back to lexical search rather than failing.
function createNimEmbedder({
  apiKey,
  model = DEFAULT_EMBED_MODEL,
  apiUrl = DEFAULT_EMBED_API_URL,
  batchSize = DEFAULT_BATCH_SIZE,
  fetchImpl,
} = {}) {
  if (!apiKey) return null;

  const request = fetchImpl ?? fetch;

  async function embed(inputs, inputType) {
    if (inputs.length === 0) return [];

    const vectors = [];

    for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize);
      const response = await request(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: batch,
          input_type: inputType,
          encoding_format: "float",
          // Long input is truncated at the end rather than rejected, so one
          // over-long chunk cannot fail an entire repository's indexing.
          truncate: "END",
        }),
      });

      if (!response.ok) {
        throw new Error(
          `NIM embedding request failed: ${response.status} ${await response.text()}`,
        );
      }

      const payload = await response.json();
      const data = Array.isArray(payload.data) ? [...payload.data] : [];

      // A short response would otherwise shift every later vector onto the
      // wrong chunk, so treat it as a failure instead of indexing misaligned
      // text.
      if (data.length !== batch.length) {
        throw new Error(
          `NIM embedding response returned ${data.length} vectors for ${batch.length} inputs.`,
        );
      }

      // `index` is the authoritative position of each vector; sorting by it
      // rather than trusting array order keeps the mapping correct even if the
      // service ever returns them out of order.
      data.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

      for (const [position, item] of data.entries()) {
        // The count can be right while the vectors are missing. A vector-less
        // item would be stored as `undefined` and only blow up much later,
        // inside the indexer's write transaction, taking the whole index down
        // with it; rejecting it here keeps an embedding problem non-fatal,
        // which is what every caller already handles.
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
          throw new Error(
            `NIM embedding response item ${position} has no vector.`,
          );
        }

        vectors.push(item.embedding);
      }
    }

    return vectors;
  }

  return {
    model,
    // Indexed file chunks.
    embedPassages: (texts) => embed(texts, "passage"),
    // The user's question.
    embedQuery: async (text) => (await embed([text], "query"))[0],
  };
}

module.exports = {
  createNimEmbedder,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_API_URL,
};
