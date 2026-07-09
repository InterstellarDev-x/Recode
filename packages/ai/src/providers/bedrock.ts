import AnthropicBedrock from "@anthropic-ai/bedrock-sdk"
import type Anthropic from "@anthropic-ai/sdk"
import type { GenerateOptions, Message, Provider, StreamEvent, ToolDefinition, Usage } from "../types.js"
import { calculateCost } from "../models.js"

function toBedrockMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const msg of messages) {
    if (msg.role === "system") continue
    const content: Anthropic.ContentBlockParam[] = []
    for (const part of msg.parts) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text })
      } else if (part.type === "image") {
        content.push({ type: "image", source: { type: "base64", media_type: part.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: part.data } })
      } else if (part.type === "tool_call") {
        content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input as Record<string, unknown> })
      } else if (part.type === "tool_result") {
        content.push({ type: "tool_result", tool_use_id: part.id, content: part.content, ...(part.isError !== undefined ? { is_error: part.isError } : {}) })
      }
    }
    if (content.length === 0) continue
    out.push({ role: msg.role as "user" | "assistant", content })
  }
  return out
}

function toBedrockTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))
}

export interface BedrockConfig {
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export function createBedrockProvider(config: BedrockConfig = {}): Provider {
  const accessKey = config.accessKeyId ?? process.env["AWS_ACCESS_KEY_ID"]
  const secretKey = config.secretAccessKey ?? process.env["AWS_SECRET_ACCESS_KEY"]
  const sessionToken = config.sessionToken ?? process.env["AWS_SESSION_TOKEN"]
  const region = config.region ?? process.env["AWS_REGION"] ?? process.env["AWS_REGION_NAME"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1"

  const credentialOpts =
    accessKey && secretKey
      ? { awsAccessKey: accessKey, awsSecretKey: secretKey, ...(sessionToken ? { awsSessionToken: sessionToken } : {}) }
      : {}

  let client: AnthropicBedrock | undefined

  function getClient(): AnthropicBedrock {
    if (!client) client = new AnthropicBedrock({ awsRegion: region, ...credentialOpts })
    return client
  }

  return {
    id: "bedrock",
    async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
      const systemMsg = options.messages.find((m) => m.role === "system")
      const system = options.system ?? systemMsg?.parts.find((p) => p.type === "text")?.text
      const messages = toBedrockMessages(options.messages.filter((m) => m.role !== "system"))

      const params = {
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        messages,
        ...(system ? { system } : {}),
        ...(options.tools?.length ? { tools: toBedrockTools(options.tools) } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }

      const requestOptions = {
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: options.maxRetries ?? 0,
      }

      const pendingInputs = new Map<string, string>()

      try {
        const stream = await getClient().messages.stream(params, requestOptions)
        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              pendingInputs.set(event.content_block.id, "")
              yield { type: "tool_call_start", id: event.content_block.id, name: event.content_block.name }
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", delta: event.delta.text }
            } else if (event.delta.type === "input_json_delta") {
              const current = stream.currentMessage
              if (current) {
                const block = current.content[event.index]
                if (block?.type === "tool_use") {
                  pendingInputs.set(block.id, (pendingInputs.get(block.id) ?? "") + event.delta.partial_json)
                  yield { type: "tool_call_delta", id: block.id, delta: event.delta.partial_json }
                }
              }
            }
          } else if (event.type === "content_block_stop") {
            const current = stream.currentMessage
            if (current) {
              const block = current.content[event.index]
              if (block?.type === "tool_use") {
                yield { type: "tool_call_end", id: block.id }
              }
            }
          } else if (event.type === "message_delta" && event.usage) {
            const current = stream.currentMessage
            if (current) {
              const rawUsage = current.usage as unknown as Record<string, number>
              const usage: Usage = {
                inputTokens: current.usage.input_tokens,
                outputTokens: event.usage.output_tokens,
                cacheReadTokens: rawUsage["cache_read_input_tokens"] ?? 0,
                cacheWriteTokens: rawUsage["cache_creation_input_tokens"] ?? 0,
                cost: undefined,
              }
              usage.cost = calculateCost(options.model, usage)
              yield { type: "done", usage }
            }
          }
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
      }
    },
  }
}
