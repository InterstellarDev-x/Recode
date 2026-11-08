import { createOpenAICompletionsProvider } from "./openai-completions.js"
import type { Provider } from "../types.js"

export function createOpenRouterProvider(apiKey?: string): Provider {
  const inner = createOpenAICompletionsProvider(
    apiKey ?? process.env["OPENROUTER_API_KEY"],
    "https://openrouter.ai/api/v1",
  )
  return { ...inner, id: "openrouter" }
}
