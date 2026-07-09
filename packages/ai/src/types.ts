export type Role = "user" | "assistant" | "system"

export interface TextPart {
  type: "text"
  text: string
}

export interface ThinkingPart {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ImagePart {
  type: "image"
  data: string      // base64-encoded
  mimeType: string  // "image/jpeg" | "image/png" | "image/gif" | "image/webp"
}

export interface ToolCallPart {
  type: "tool_call"
  id: string
  name: string
  input: unknown
}

export interface ToolResultPart {
  type: "tool_result"
  id: string
  content: string
  isError?: boolean
}

export type MessagePart = TextPart | ThinkingPart | ImagePart | ToolCallPart | ToolResultPart

export interface Message {
  role: Role
  parts: MessagePart[]
}

export function userMessage(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] }
}

export function assistantMessage(parts: MessagePart[]): Message {
  return { role: "assistant", parts }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "done"; usage?: Usage }
  | { type: "error"; error: Error }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  } | undefined
}

export interface GenerateOptions {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  maxRetries?: number
  maxRetryDelayMs?: number
}

export interface Provider {
  id: string
  stream(options: GenerateOptions): AsyncGenerator<StreamEvent>
}
