import type { Provider } from "./types.js"
import { createAnthropicProvider } from "./providers/anthropic.js"
import { createOpenAIProvider } from "./providers/openai.js"
import { createAzureProvider } from "./providers/azure.js"
import { createGoogleProvider } from "./providers/google.js"
import { createBedrockProvider, type BedrockConfig } from "./providers/bedrock.js"
import { createOpenRouterProvider } from "./providers/openrouter.js"
import { DEFAULT_MODELS } from "./models.js"

export type ProviderName = "anthropic" | "openai" | "azure" | "google" | "bedrock" | "openrouter"

export interface ProviderConfig {
  anthropic?: { apiKey?: string }
  openai?: { apiKey?: string }
  azure?: { apiKey?: string; endpoint?: string; deployment?: string }
  google?: { apiKey?: string }
  bedrock?: BedrockConfig
  openrouter?: { apiKey?: string }
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>()

  constructor(config: ProviderConfig = {}) {
    this.providers.set("anthropic", createAnthropicProvider(config.anthropic?.apiKey))
    this.providers.set("openai", createOpenAIProvider(config.openai?.apiKey))
    this.providers.set("azure", createAzureProvider(config.azure))
    this.providers.set("google", createGoogleProvider(config.google?.apiKey))
    this.providers.set("bedrock", createBedrockProvider(config.bedrock ?? {}))
    this.providers.set("openrouter", createOpenRouterProvider(config.openrouter?.apiKey))
  }

  get(name: ProviderName): Provider {
    const p = this.providers.get(name)
    if (!p) throw new Error(`Unknown provider: ${name}`)
    return p
  }

  defaultModel(name: ProviderName): string {
    return DEFAULT_MODELS[name] ?? ""
  }

  list(): ProviderName[] {
    return ["anthropic", "openai", "azure", "google", "bedrock", "openrouter"]
  }
}
