import type { GenerateOptions, Message, Provider, StreamEvent, ToolDefinition, Usage } from "../types.js"
import { calculateCost } from "../models.js"

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: { content: string } }
}

function toGeminiContents(messages: Message[]): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const out: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = []
  for (const msg of messages) {
    if (msg.role === "system") continue
    const parts: GeminiPart[] = []
    for (const part of msg.parts) {
      if (part.type === "text") parts.push({ text: part.text })
      else if (part.type === "tool_call") parts.push({ functionCall: { name: part.name, args: part.input as Record<string, unknown> } })
      else if (part.type === "tool_result") {
        // Gemini requires functionResponse.name to match the functionCall.name, not the id.
        // The id stored in ToolResultPart is the tool_call id; we look up the matching
        // tool_call in the same message parts to find the real function name, with
        // a safe fallback to the id itself.
        const matchingCall = msg.parts.find((p) => p.type === "tool_call" && p.id === part.id)
        const fnName = matchingCall?.type === "tool_call" ? matchingCall.name : part.id
        parts.push({ functionResponse: { name: fnName, response: { content: part.content } } })
      }
    }
    if (parts.length === 0) continue
    out.push({ role: msg.role === "assistant" ? "model" : "user", parts })
  }
  return out
}

function toGeminiTools(tools: ToolDefinition[]) {
  if (tools.length === 0) return []
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }]
}

export function createGoogleProvider(apiKey?: string): Provider {
  const key = apiKey ?? process.env["GOOGLE_API_KEY"] ?? ""

  return {
    id: "google",
    async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
      const systemMsg = options.messages.find((m) => m.role === "system")
      const systemInstruction = options.system ?? systemMsg?.parts.find((p) => p.type === "text")?.text
      const contents = toGeminiContents(options.messages.filter((m) => m.role !== "system"))

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 8192,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        ...(options.tools?.length ? { tools: toGeminiTools(options.tools) } : {}),
      }

      const url = `${GEMINI_BASE}/models/${options.model}:streamGenerateContent?key=${key}&alt=sse`

      try {
        const fetchOpts: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        if (options.timeoutMs !== undefined) {
          const controller = new AbortController()
          setTimeout(() => controller.abort(), options.timeoutMs)
          fetchOpts.signal = controller.signal
        }
        const resp = await fetch(url, fetchOpts)
        if (!resp.ok) { yield { type: "error", error: new Error(`Gemini ${resp.status}: ${await resp.text()}`) }; return }

        const reader = resp.body?.getReader()
        if (!reader) { yield { type: "error", error: new Error("No response body") }; return }

        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const jsonStr = line.slice(6).trim()
            if (!jsonStr || jsonStr === "[DONE]") continue
            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(jsonStr) } catch { continue }

            const candidates = (chunk["candidates"] as Array<{ content?: { parts: GeminiPart[] } }>) ?? []
            for (const candidate of candidates) {
              if (!candidate.content) continue
              for (const part of candidate.content.parts) {
                if (part.text) yield { type: "text_delta", delta: part.text }
                else if (part.functionCall) {
                  const id = `${part.functionCall.name}-${Math.random().toString(36).slice(2)}`
                  yield { type: "tool_call_start", id, name: part.functionCall.name }
                  yield { type: "tool_call_delta", id, delta: JSON.stringify(part.functionCall.args) }
                  yield { type: "tool_call_end", id }
                }
              }
            }

            const meta = chunk["usageMetadata"] as { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined
            if (meta) {
              const usage: Usage = {
                inputTokens: meta.promptTokenCount ?? 0,
                outputTokens: meta.candidatesTokenCount ?? 0,
                cacheReadTokens: meta.cachedContentTokenCount ?? 0,
                cacheWriteTokens: 0,
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
