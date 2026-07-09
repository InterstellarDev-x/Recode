import type { Usage } from "./types.js"

// Cost in USD per 1M tokens
export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelInfo {
  id: string
  provider: "anthropic" | "openai" | "azure" | "google" | "bedrock" | "openrouter"
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  cost: ModelCost
}

const FREE: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const MODELS: ModelInfo[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  { id: "claude-sonnet-4-5",           provider: "anthropic", displayName: "Claude Sonnet 4.5",          contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "claude-sonnet-4-6",           provider: "anthropic", displayName: "Claude Sonnet 4.6",          contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "claude-opus-4-8",             provider: "anthropic", displayName: "Claude Opus 4.8",            contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 } },
  { id: "claude-haiku-4-5-20251001",   provider: "anthropic", displayName: "Claude Haiku 4.5",           contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  } },
  { id: "claude-3-5-sonnet-20241022",  provider: "anthropic", displayName: "Claude 3.5 Sonnet",          contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "claude-3-5-haiku-20241022",   provider: "anthropic", displayName: "Claude 3.5 Haiku",           contextWindow: 200_000, maxOutputTokens: 8192,   cost: { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  } },
  { id: "claude-3-opus-20240229",      provider: "anthropic", displayName: "Claude 3 Opus",              contextWindow: 200_000, maxOutputTokens: 4096,   cost: { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 } },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { id: "gpt-4o",                      provider: "openai",    displayName: "GPT-4o",                     contextWindow: 128_000, maxOutputTokens: 16384,  cost: { input: 2.50,  output: 10.00, cacheRead: 1.25,  cacheWrite: 0     } },
  { id: "gpt-4o-mini",                 provider: "openai",    displayName: "GPT-4o Mini",                contextWindow: 128_000, maxOutputTokens: 16384,  cost: { input: 0.15,  output: 0.60,  cacheRead: 0.075, cacheWrite: 0     } },
  { id: "gpt-4-turbo",                 provider: "openai",    displayName: "GPT-4 Turbo",                contextWindow: 128_000, maxOutputTokens: 4096,   cost: { input: 10.00, output: 30.00, cacheRead: 5.00,  cacheWrite: 0     } },
  { id: "gpt-4",                       provider: "openai",    displayName: "GPT-4",                      contextWindow:   8_192, maxOutputTokens: 8192,   cost: { input: 30.00, output: 60.00, cacheRead: 0,     cacheWrite: 0     } },
  { id: "o3-mini",                     provider: "openai",    displayName: "o3-mini",                    contextWindow: 128_000, maxOutputTokens: 65536,  cost: { input: 1.10,  output: 4.40,  cacheRead: 0.55,  cacheWrite: 0     } },
  { id: "o3",                          provider: "openai",    displayName: "o3",                         contextWindow: 200_000, maxOutputTokens: 100_000,cost: { input: 10.00, output: 40.00, cacheRead: 2.50,  cacheWrite: 0     } },
  { id: "o1",                          provider: "openai",    displayName: "o1",                         contextWindow: 200_000, maxOutputTokens: 100_000,cost: { input: 15.00, output: 60.00, cacheRead: 7.50,  cacheWrite: 0     } },
  { id: "o1-mini",                     provider: "openai",    displayName: "o1-mini",                    contextWindow: 128_000, maxOutputTokens: 65536,  cost: { input: 3.00,  output: 12.00, cacheRead: 1.50,  cacheWrite: 0     } },

  // ── Google ─────────────────────────────────────────────────────────────────
  { id: "gemini-2.0-flash",            provider: "google",    displayName: "Gemini 2.0 Flash",           contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 0.10,  output: 0.40,  cacheRead: 0.025, cacheWrite: 0     } },
  { id: "gemini-2.5-pro",              provider: "google",    displayName: "Gemini 2.5 Pro",             contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 1.25,  output: 10.00, cacheRead: 0.31,  cacheWrite: 0     } },
  { id: "gemini-2.5-flash",            provider: "google",    displayName: "Gemini 2.5 Flash",           contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 0.15,  output: 0.60,  cacheRead: 0.037, cacheWrite: 0     } },
  { id: "gemini-1.5-pro",              provider: "google",    displayName: "Gemini 1.5 Pro",             contextWindow: 2_000_000, maxOutputTokens: 8192, cost: { input: 1.25,  output: 5.00,  cacheRead: 0.31,  cacheWrite: 0     } },
  { id: "gemini-1.5-flash",            provider: "google",    displayName: "Gemini 1.5 Flash",           contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 0.075, output: 0.30,  cacheRead: 0.018, cacheWrite: 0     } },
  { id: "gemini-2.0-flash-lite",       provider: "google",    displayName: "Gemini 2.0 Flash Lite",      contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 0.075, output: 0.30,  cacheRead: 0,     cacheWrite: 0     } },

  // ── AWS Bedrock ────────────────────────────────────────────────────────────
  { id: "us.anthropic.claude-sonnet-4-6",               provider: "bedrock", displayName: "Claude Sonnet 4.6 (Bedrock)",  contextWindow: 200_000, maxOutputTokens: 8192, cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "us.anthropic.claude-sonnet-4-5-20251001-v1:0", provider: "bedrock", displayName: "Claude Sonnet 4.5 (Bedrock)",  contextWindow: 200_000, maxOutputTokens: 8192, cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "us.anthropic.claude-opus-4-5-20251101-v1:0",   provider: "bedrock", displayName: "Claude Opus 4.5 (Bedrock)",    contextWindow: 200_000, maxOutputTokens: 8192, cost: { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 } },
  { id: "us.anthropic.claude-haiku-3-5-20241022-v1:0",  provider: "bedrock", displayName: "Claude Haiku 3.5 (Bedrock)",   contextWindow: 200_000, maxOutputTokens: 8192, cost: { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  } },

  // ── OpenRouter ─────────────────────────────────────────────────────────────
  { id: "openrouter/auto",                                      provider: "openrouter", displayName: "OpenRouter Auto",                   contextWindow: 200_000, maxOutputTokens: 8192,  cost: FREE },
  { id: "openrouter/anthropic/claude-sonnet-4-5",               provider: "openrouter", displayName: "Claude Sonnet 4.5 (OpenRouter)",    contextWindow: 200_000, maxOutputTokens: 8192,  cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: "openrouter/openai/gpt-4o",                             provider: "openrouter", displayName: "GPT-4o (OpenRouter)",               contextWindow: 128_000, maxOutputTokens: 16384, cost: { input: 2.50,  output: 10.00, cacheRead: 1.25,  cacheWrite: 0     } },
  { id: "openrouter/meta-llama/llama-3.1-405b-instruct",        provider: "openrouter", displayName: "Llama 3.1 405B (OpenRouter)",       contextWindow: 128_000, maxOutputTokens: 8192,  cost: { input: 2.70,  output: 2.70,  cacheRead: 0,     cacheWrite: 0     } },
  { id: "openrouter/google/gemini-2.0-flash",                   provider: "openrouter", displayName: "Gemini 2.0 Flash (OpenRouter)",     contextWindow: 1_000_000, maxOutputTokens: 8192, cost: { input: 0.10, output: 0.40,  cacheRead: 0.025, cacheWrite: 0     } },
  { id: "openrouter/deepseek/deepseek-chat",                    provider: "openrouter", displayName: "DeepSeek Chat (OpenRouter)",         contextWindow:  64_000, maxOutputTokens: 8192,  cost: { input: 0.14,  output: 0.28,  cacheRead: 0.014, cacheWrite: 0     } },
  { id: "openrouter/mistralai/mistral-large",                   provider: "openrouter", displayName: "Mistral Large (OpenRouter)",         contextWindow: 128_000, maxOutputTokens: 8192,  cost: { input: 3.00,  output: 9.00,  cacheRead: 0,     cacheWrite: 0     } },
]

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic:  "claude-sonnet-4-5",
  openai:     "gpt-4o",
  azure:      "gpt-4o",
  google:     "gemini-2.0-flash",
  bedrock:    "us.anthropic.claude-sonnet-4-6",
  openrouter: "openrouter/auto",
}

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id)
}

export function modelsForProvider(provider: string): ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider)
}

export function calculateCost(modelId: string, usage: Usage): Usage["cost"] {
  const model = getModel(modelId)
  const rates: ModelCost = model?.cost ?? FREE
  const perM = 1_000_000
  const input     = (rates.input      / perM) * usage.inputTokens
  const output    = (rates.output     / perM) * usage.outputTokens
  const cacheRead = (rates.cacheRead  / perM) * usage.cacheReadTokens
  const cacheWrite= (rates.cacheWrite / perM) * usage.cacheWriteTokens
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}
