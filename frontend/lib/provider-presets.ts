export type ProviderPreset = {
  key: string;
  label: string;
  url: string;
  model: string;
  hint?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "",
    hint: "400+ models behind one key — teapot sends app-attribution headers automatically",
  },
  {
    key: "orcarouter",
    label: "OrcaRouter",
    url: "https://api.orcarouter.ai/v1",
    model: "",
    hint: "zero-markup routing gateway — 'orcarouter/auto' grades each prompt and picks the model",
  },
  {
    key: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "",
    hint: "your account's models — pick from the list once the endpoint answers",
  },
  {
    key: "opencode-go",
    label: "OpenCode Go",
    url: "https://opencode.ai/zen/go/v1",
    model: "",
    hint: "OpenCode's open-model subscription — teapot sends the required x-opencode-session header; choose a chat/completions model",
  },
  {
    key: "llamacpp",
    label: "llama.cpp server",
    url: "http://localhost:8080/v1",
    model: "",
    hint: "free & local — start it with: llama-server -m ./model.gguf  (any model name works)",
  },
];
