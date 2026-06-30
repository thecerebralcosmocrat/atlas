const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.NVIDIA_NIM_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

module.exports = { client };
