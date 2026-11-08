import OpenAI from "openai"
import type { GenerateOptions, Message, Provider, ReasoningEffort, StreamEvent, ToolDefinition, Usage } from "../types.js"
import { calculateCost } from "../models.js"

const MIN_OUTPUT_TOKENS = 16
const CACHE_STABLE_EFFORT = "medium"

/** Current OpenAI reasoning models. gpt-4o and older stay on a plain Responses request. */
function modelReasons(model: string): boolean {
  return /^(o\d|gpt-5|gpt-6)/i.test(model)
}

/**
 * GPT-5.6 and later, including gpt-6-luna, reject `prompt_cache_retention`.
 * Their lifetime is `prompt_cache_options.ttl`, and the server default is 30m.
 * GPT-5.5 accepts only `prompt_cache_retention: "24h"`. Older models accept
 * `in_memory` or `24h`; omitting the field keeps the server default.
 */
function promptCacheRetention(model: string): "24h" | undefined {
  return /^gpt-5\.5/i.test(model) ? "24h" : undefined
}

/** A ChatGPT subscription token does not start with `sk-`. Those logins reject several request fields. */
function isChatGPTSignIn(apiKey: string | undefined): boolean {
  return apiKey !== undefined && apiKey.length > 0 && !apiKey.startsWith("sk-")
}

function toolOutput(content: string): string {
  return content.trim().length === 0 ? "(empty)" : content
}

function splitToolCallId(id: string): { callId: string; itemId?: string } {
  const pipe = id.indexOf("|")
  if (pipe === -1) return { callId: id }
  const callId = id.slice(0, pipe)
  const itemId = id.slice(pipe + 1)
  return itemId.startsWith("fc_") ? { callId, itemId } : { callId }
}

type ResponseInputItem = Record<string, unknown>

function textOf(parts: Message["parts"]): string {
  return parts.filter((p) => p.type === "text").map((p) => p.type === "text" ? p.text : "").join("")
}

/**
 * Build a Responses `input` list.
 * The full transcript is sent every call (`store: false`). System text leads as
 * `developer` on reasoning models. Tool results are `function_call_output`.
 * Reasoning items are replayed from `thinkingSignature`. A thinking-level change
 * is a `configuration_update` item so `reasoning.effort` itself stays stable.
 */
function toResponsesInput(options: GenerateOptions, reasons: boolean, subscription: boolean): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  const instructionRole = reasons ? "developer" : "system"
  const systemParts: string[] = []
  if (options.system) systemParts.push(options.system)
  for (const msg of options.messages) {
    if (msg.role !== "system") continue
    const text = textOf(msg.parts)
    if (text) systemParts.push(text)
  }
  if (systemParts.length > 0) {
    input.push({ role: instructionRole, content: systemParts.join("\n\n") })
  }

  const useConfigurationUpdate = reasons && options.reasoningEffort !== undefined && !subscription
  const currentEffort = options.reasoningEffort

  for (const msg of options.messages) {
    if (msg.role === "system") continue

    if (msg.role === "user") {
      const toolResults = msg.parts.filter((p) => p.type === "tool_result")
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          if (part.type !== "tool_result") continue
          const { callId } = splitToolCallId(part.id)
          input.push({
            type: "function_call_output",
            call_id: callId,
            output: toolOutput(part.content),
          })
        }
        continue
      }
      const content: ResponseInputItem[] = []
      for (const part of msg.parts) {
        if (part.type === "text") content.push({ type: "input_text", text: part.text })
        else if (part.type === "image") {
          content.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` })
        }
      }
      if (content.length > 0) input.push({ role: "user", content })
      continue
    }

    const thinking = msg.parts.find((p) => p.type === "thinking")
    if (useConfigurationUpdate && thinking?.type === "thinking" && thinking.reasoningEffort) {
      input.push({ type: "configuration_update", reasoning: { effort: thinking.reasoningEffort } })
    }

    for (const part of msg.parts) {
      if (part.type === "thinking" && part.thinkingSignature) {
        try {
          input.push(JSON.parse(part.thinkingSignature) as ResponseInputItem)
        } catch { /* a summary without a signature cannot be replayed */ }
      }
    }

    const text = textOf(msg.parts)
    if (text) {
      input.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      })
    }

    for (const part of msg.parts) {
      if (part.type !== "tool_call") continue
      const { callId, itemId } = splitToolCallId(part.id)
      input.push({
        type: "function_call",
        ...(itemId ? { id: itemId } : {}),
        call_id: callId,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      })
    }
  }

  if (useConfigurationUpdate && currentEffort) {
    input.push({ type: "configuration_update", reasoning: { effort: currentEffort } })
  }

  return input
}

function toResponsesTools(tools: ToolDefinition[]): ResponseInputItem[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))
}

interface ResponseUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
}

function usageFromResponse(model: string, usage: ResponseUsage | undefined): Usage {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage?.input_tokens_details?.cache_write_tokens ?? 0
  const result: Usage = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    cost: undefined,
  }
  result.cost = calculateCost(model, result)
  return result
}

/**
 * OpenAI provider. Speaks the Responses API and sends the whole transcript
 * on every call. Chat Completions stays in `openai-completions.ts` for
 * Azure and OpenRouter.
 */
export function createOpenAIResponsesProvider(apiKey?: string): Provider {
  let client: OpenAI | undefined
  const resolvedKey = apiKey ?? process.env["OPENAI_API_KEY"]

  function getClient(): OpenAI {
    if (!client) client = new OpenAI({ apiKey: resolvedKey })
    return client
  }

  return {
    id: "openai",
    async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
      const reasons = modelReasons(options.model)
      const subscription = isChatGPTSignIn(resolvedKey)
      const input = toResponsesInput(options, reasons, subscription)
      const pending = new Map<number, { id: string; name: string; args: string; ended: boolean }>()
      let emittedDone = false

      const effort: ReasoningEffort | undefined = reasons
        ? (options.reasoningEffort !== undefined && !subscription ? CACHE_STABLE_EFFORT : (options.reasoningEffort ?? "medium"))
        : undefined

      const params: Record<string, unknown> = {
        model: options.model,
        input,
        stream: true,
        store: false,
      }
      if (options.sessionId && !subscription) {
        params["prompt_cache_key"] = options.sessionId
        const retention = promptCacheRetention(options.model)
        if (retention) params["prompt_cache_retention"] = retention
      }
      if (!subscription) {
        const maxTokens = options.maxTokens ?? 8192
        params["max_output_tokens"] = Math.max(maxTokens, MIN_OUTPUT_TOKENS)
      }
      if (options.temperature !== undefined && !subscription) params["temperature"] = options.temperature
      if (options.tools?.length) {
        params["tools"] = toResponsesTools(options.tools)
        params["tool_choice"] = "auto"
      }
      if (effort) {
        params["reasoning"] = { effort, summary: "auto" }
        params["include"] = ["reasoning.encrypted_content"]
      }

      const requestOptions: OpenAI.RequestOptions = {
        maxRetries: options.maxRetries ?? 0,
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.sessionId
          ? { headers: { "session-id": options.sessionId, "x-client-request-id": options.sessionId } }
          : {}),
      }

      try {
        const stream = await getClient().responses.create(
          params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
          requestOptions,
        )

        for await (const event of stream) {
          if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
            yield { type: "text_delta", delta: event.delta }
            continue
          }
          if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
            yield { type: "thinking_delta", delta: event.delta }
            continue
          }
          if (event.type === "response.output_item.added" && event.item.type === "function_call") {
            const id = `${event.item.call_id}|${event.item.id}`
            pending.set(event.output_index, { id, name: event.item.name, args: "", ended: false })
            yield { type: "tool_call_start", id, name: event.item.name }
            continue
          }
          if (event.type === "response.function_call_arguments.delta") {
            const call = pending.get(event.output_index)
            if (!call) continue
            call.args += event.delta
            yield { type: "tool_call_delta", id: call.id, delta: event.delta }
            continue
          }
          if (event.type === "response.function_call_arguments.done" || (event.type === "response.output_item.done" && event.item.type === "function_call")) {
            const call = pending.get(event.output_index)
            if (call && !call.ended) {
              call.ended = true
              yield { type: "tool_call_end", id: call.id }
            }
            continue
          }
          if (event.type === "response.output_item.done" && event.item.type === "reasoning") {
            yield { type: "thinking_signature", signature: JSON.stringify(event.item) }
            continue
          }
          if (event.type === "response.completed" || event.type === "response.incomplete") {
            emittedDone = true
            yield { type: "done", usage: usageFromResponse(options.model, event.response.usage) }
            continue
          }
          if (event.type === "response.failed") {
            const message = event.response.error?.message ?? "OpenAI Responses request failed"
            yield { type: "error", error: new Error(message) }
            return
          }
          if (event.type === "error") {
            yield { type: "error", error: new Error(event.message) }
            return
          }
        }

        for (const call of pending.values()) {
          if (!call.ended) yield { type: "tool_call_end", id: call.id }
        }
        if (!emittedDone) {
          yield { type: "done", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: undefined } }
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
      }
    },
  }
}
