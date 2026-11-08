import type { GenerateOptions, Provider, StreamEvent } from "../types.js"
import { createOpenAICompletionsProvider } from "./openai-completions.js"

export function createAzureProvider(opts?: { apiKey?: string; endpoint?: string; deployment?: string }): Provider {
  const apiKey = opts?.apiKey ?? process.env["AZURE_OPENAI_API_KEY"] ?? ""
  const endpoint = opts?.endpoint ?? process.env["AZURE_OPENAI_ENDPOINT"] ?? ""
  const deployment = opts?.deployment ?? process.env["AZURE_OPENAI_DEPLOYMENT"] ?? ""
  const baseURL = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}`
  const inner = createOpenAICompletionsProvider(apiKey, baseURL)

  return {
    id: "azure",
    async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
      yield* inner.stream({ ...options, model: deployment || options.model })
    },
  }
}
