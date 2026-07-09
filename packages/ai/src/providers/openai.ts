import OpenAI from "openai"
import type { GenerateOptions, Message, Provider, StreamEvent, ToolDefinition, Usage } from "../types.js"
import { calculateCost } from "../models.js"

function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = []
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.parts.find((p) => p.type === "text")?.text ?? "" })
      continue
    }
    if (msg.role === "user") {
      const toolResults = msg.parts.filter((p) => p.type === "tool_result")
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          if (part.type === "tool_result") {
            out.push({ role: "tool", tool_call_id: part.id, content: part.content })
          }
        }
      } else {
        const content: OpenAI.ChatCompletionContentPart[] = []
        for (const part of msg.parts) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text })
          } else if (part.type === "image") {
            content.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } })
          }
        }
        out.push({ role: "user", content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content })
      }
      continue
    }
    if (msg.role === "assistant") {
      const text = msg.parts.filter((p) => p.type === "text").map((p) => p.type === "text" ? p.text : "").join("")
      const toolCalls = msg.parts.filter((p) => p.type === "tool_call")
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.map((tc) => {
            if (tc.type !== "tool_call") throw new Error("unreachable")
            return { id: tc.id, type: "function" as const, function: { name: tc.name, arguments: JSON.stringify(tc.input) } }
          }),
        })
      } else {
        out.push({ role: "assistant", content: text })
      }
    }
  }
  return out
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
}

export function createOpenAIProvider(apiKey?: string, baseURL?: string): Provider {
  let client: OpenAI | undefined

  function getClient(): OpenAI {
    if (!client) {
      client = new OpenAI({ apiKey: apiKey ?? process.env["OPENAI_API_KEY"], ...(baseURL ? { baseURL } : {}) })
    }
    return client
  }

  return {
    id: "openai",
    async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
      const messages = toOpenAIMessages(options.messages)
      if (options.system) messages.unshift({ role: "system", content: options.system })

      const pending = new Map<number, { id: string; name: string; args: string }>()

      try {
        const reqOpts: Record<string, unknown> = { maxRetries: options.maxRetries ?? 0 }
        if (options.timeoutMs !== undefined) reqOpts["timeout"] = options.timeoutMs

        const stream = await getClient().chat.completions.create(
          {
            model: options.model,
            messages,
            max_tokens: options.maxTokens ?? 8192,
            stream: true,
            stream_options: { include_usage: true },
            ...(options.tools?.length ? { tools: toOpenAITools(options.tools), tool_choice: "auto" } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          },
          reqOpts as Record<string, unknown>,
        )

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta
          if (!delta) {
            if (chunk.usage) {
              const rawChunkUsage = chunk.usage as unknown as Record<string, unknown>
              const details = rawChunkUsage["prompt_tokens_details"] as Record<string, number> | undefined
              const usage: Usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                cacheReadTokens: details?.["cached_tokens"] ?? 0,
                cacheWriteTokens: 0,
                cost: undefined,
              }
              usage.cost = calculateCost(options.model, usage)
              yield { type: "done", usage }
            }
            continue
          }
          if (delta.content) yield { type: "text_delta", delta: delta.content }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                pending.set(tc.index, { id: tc.id, name: tc.function?.name ?? "", args: "" })
                yield { type: "tool_call_start", id: tc.id, name: tc.function?.name ?? "" }
              }
              const existing = pending.get(tc.index)
              if (existing && tc.function?.arguments) {
                existing.args += tc.function.arguments
                yield { type: "tool_call_delta", id: existing.id, delta: tc.function.arguments }
              }
            }
          }
          if (chunk.choices[0]?.finish_reason === "tool_calls") {
            for (const call of pending.values()) yield { type: "tool_call_end", id: call.id }
            pending.clear()
          }
          // `done` is emitted once the usage chunk arrives (handled above).
          // If the stream ends with finish_reason "stop" but no usage has arrived yet,
          // emit a minimal done so callers are not left hanging.
          if (chunk.choices[0]?.finish_reason === "stop" && !chunk.usage) {
            yield { type: "done", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: undefined } }
          }
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
      }
    },
  }
}
