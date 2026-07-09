/**
 * Context compaction for long sessions.
 *
 * Pure functions — no I/O.  The AgentHarness / Session handle persistence.
 *
 * Architecture mirrors Pi's compaction module:
 *   1. estimateTokens      – chars/4 heuristic (images = 4800 chars)
 *   2. shouldCompact       – threshold check against (contextWindow - reserveTokens)
 *   3. serializeMessages   – plain [User]: / [Assistant]: text for the LLM prompt
 *   4. generateSummary     – sends transcript as a single user message, structured prompt
 *   5. buildCompactionPrompt – used internally by generateSummary
 */

import type { Provider } from "@recode/ai"
import { userMessage, type Message, type MessagePart } from "@recode/ai"

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CompactionSettings {
  /**
   * When true, auto-compaction is enabled.
   * The harness checks after every agent_end.
   */
  enabled: boolean

  /**
   * How many tokens to keep free for the model's next response.
   * Compaction fires when: contextTokens > contextWindow - reserveTokens
   *
   * Default: 16_384  (matches Pi)
   */
  reserveTokens: number

  /**
   * Approximate number of recent tokens to preserve when selecting the cut point.
   * Everything older than this window is summarized and dropped.
   *
   * Default: 20_000  (matches Pi)
   */
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const ESTIMATED_IMAGE_CHARS = 4_800  // Pi constant

/**
 * Estimate the token cost of a message using chars/4 heuristic.
 * Real usage from the API is preferred when available.
 */
export function estimateTokens(message: Message): number {
  let chars = 0
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        chars += part.text.length
        break
      case "thinking":
        chars += part.thinking.length
        break
      case "tool_call":
        chars += part.name.length + JSON.stringify(part.input).length
        break
      case "tool_result":
        chars += part.content.length
        break
      case "image":
        chars += ESTIMATED_IMAGE_CHARS
        break
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Estimate the total context token count for a message array.
 */
export function estimateContextTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) total += estimateTokens(msg)
  return total
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

/**
 * Returns true when compaction should fire.
 *
 * @param contextTokens  – current usage (input + cache reads + cache writes)
 * @param contextWindow  – model's published context window (0 = unknown)
 * @param settings       – compaction settings
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false
  if (contextWindow === 0) return false
  return contextTokens > contextWindow - settings.reserveTokens
}

// ---------------------------------------------------------------------------
// Message serialization (for the summarization prompt)
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2_000  // Pi constant — truncate long tool results

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, max)}\n\n[… ${dropped} more characters truncated]`
}

/**
 * Serialize a Message array to plain text so the summarizing LLM cannot
 * mistake it for a live conversation.
 *
 * Format mirrors Pi:
 *   [User]: …
 *   [Assistant thinking]: …
 *   [Assistant]: …
 *   [Assistant tool calls]: name(k=v, …); …
 *   [Tool result]: …
 */
export function serializeMessages(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      const textParts = msg.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
      if (textParts) parts.push(`[User]: ${textParts}`)
    } else if (msg.role === "assistant") {
      const texts:     string[] = []
      const thinking:  string[] = []
      const toolCalls: string[] = []
      const toolResults: string[] = []

      for (const part of msg.parts) {
        if (part.type === "text") {
          texts.push(part.text)
        } else if (part.type === "thinking") {
          thinking.push(part.thinking)
        } else if (part.type === "tool_call") {
          const argsStr = Object.entries(part.input as Record<string, unknown>)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ")
          toolCalls.push(`${part.name}(${argsStr})`)
        } else if (part.type === "tool_result") {
          toolResults.push(truncate(part.content, TOOL_RESULT_MAX_CHARS))
        }
      }

      if (thinking.length > 0)    parts.push(`[Assistant thinking]: ${thinking.join("\n")}`)
      if (texts.length > 0)       parts.push(`[Assistant]: ${texts.join("\n")}`)
      if (toolCalls.length > 0)   parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`)
      if (toolResults.length > 0) parts.push(`[Tool result]: ${toolResults.join("\n---\n")}`)
    }
  }

  // Also handle user messages that contain tool results (how ReCode stores them)
  // Those were already added above via the assistant branch — but tool_results
  // in *user* messages (API grouping) need special handling:
  // We already covered them because the harness stores tool results as user message
  // parts of type "tool_result". Re-check:
  // Actually the loop above handles user messages only for "text" parts.
  // Let's add tool_result extraction from user messages too:
  const corrected: string[] = []
  for (const msg of messages) {
    if (msg.role === "user") {
      const textParts = msg.parts.filter((p) => p.type === "text")
      const resultParts = msg.parts.filter((p): p is { type: "tool_result"; id: string; content: string; isError?: boolean } => p.type === "tool_result")

      const textContent = textParts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
      if (textContent) corrected.push(`[User]: ${textContent}`)

      for (const r of resultParts) {
        corrected.push(`[Tool result]: ${truncate(r.content, TOOL_RESULT_MAX_CHARS)}`)
      }
    }
  }

  // Rebuild properly handling both roles
  return buildSerializedText(messages)
}

/** Internal serializer that handles all message shapes correctly */
function buildSerializedText(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      // Text parts (user prose)
      const textContent = msg.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
      if (textContent) parts.push(`[User]: ${textContent}`)

      // Tool result parts (API groups them into user messages)
      for (const p of msg.parts) {
        if (p.type === "tool_result") {
          parts.push(`[Tool result]: ${truncate(p.content, TOOL_RESULT_MAX_CHARS)}`)
        }
      }
    } else if (msg.role === "assistant") {
      const texts:     string[] = []
      const thinking:  string[] = []
      const toolCalls: string[] = []

      for (const part of msg.parts) {
        if (part.type === "text") {
          texts.push(part.text)
        } else if (part.type === "thinking") {
          thinking.push(part.thinking)
        } else if (part.type === "tool_call") {
          const input = part.input as Record<string, unknown>
          const argsStr = Object.entries(input)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ")
          toolCalls.push(`${part.name}(${argsStr})`)
        }
      }

      if (thinking.length > 0)  parts.push(`[Assistant thinking]: ${thinking.join("\n")}`)
      if (texts.length > 0)     parts.push(`[Assistant]: ${texts.join("\n")}`)
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`)
    }
  }

  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Summarization prompts  (mirrors Pi's SUMMARIZATION_PROMPT)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const INITIAL_PROMPT =
  `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_PROMPT =
  `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a structured summary of `messages` using `provider`/`model`.
 *
 * If `previousSummary` is provided the UPDATE prompt is used so context
 * accumulates incrementally across multiple compactions (Pi pattern).
 *
 * @returns The summary text, or throws on error.
 */
export async function generateSummary(
  messages: Message[],
  provider: Provider,
  model: string,
  previousSummary?: string,
  signal?: AbortSignal,
): Promise<string> {
  const conversationText = buildSerializedText(messages)
  const basePrompt = previousSummary ? UPDATE_PROMPT : INITIAL_PROMPT

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
  }
  promptText += basePrompt

  const requestMessages: Message[] = [userMessage(promptText)]

  let summary = ""
  const stream = provider.stream({
    model,
    system: SYSTEM_PROMPT,
    messages: requestMessages,
    maxTokens: 8_192,
  })

  for await (const event of stream) {
    if (signal?.aborted) throw new Error("Compaction aborted")
    if (event.type === "text_delta") summary += event.delta
    if (event.type === "error") throw event.error
    if (event.type === "done") break
  }

  if (!summary.trim()) throw new Error("Summarization produced empty output")
  return summary.trim()
}

// ---------------------------------------------------------------------------
// File-operation extraction (Pi pattern — appended to summary as XML tags)
// ---------------------------------------------------------------------------

interface FileOps {
  read:    Set<string>
  written: Set<string>
  edited:  Set<string>
}

function createFileOps(): FileOps {
  return { read: new Set(), written: new Set(), edited: new Set() }
}

function extractFileOpsFromMessages(messages: Message[], ops: FileOps): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool_call") continue
      const input = part.input as Record<string, unknown>
      const path = typeof input["path"] === "string" ? input["path"] : undefined
      if (!path) continue
      switch (part.name) {
        case "read":  ops.read.add(path);    break
        case "write": ops.written.add(path); break
        case "edit":  ops.edited.add(path);  break
      }
    }
  }
}

function formatFileOps(ops: FileOps): string {
  const modified = new Set([...ops.edited, ...ops.written])
  const readOnly = [...ops.read].filter((f) => !modified.has(f)).sort()
  const modifiedFiles = [...modified].sort()

  const sections: string[] = []
  if (readOnly.length > 0)      sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`)
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`)
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""
}

// ---------------------------------------------------------------------------
// Cut-point selection  (Pi's keepRecentTokens algorithm)
// ---------------------------------------------------------------------------

/**
 * Walk backwards through messages accumulating estimated tokens until we
 * exceed `keepRecentTokens`.  Return the index of the first message to keep.
 *
 * - We never cut inside a tool-call/result pair.
 * - We always cut at a user message boundary.
 */
function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let accumulated = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]!)
    if (accumulated >= keepRecentTokens) {
      // Walk forward to the next user message so we don't split a turn
      for (let j = i; j < messages.length; j++) {
        if (messages[j]!.role === "user") return j
      }
      return i
    }
  }

  // Everything fits inside keepRecentTokens — keep it all
  return 0
}

// ---------------------------------------------------------------------------
// Top-level compaction function
// ---------------------------------------------------------------------------

export interface CompactionResult {
  /** The structured summary text */
  summary: string
  /** Approximate token count BEFORE this compaction (for display) */
  tokensBefore: number
  /**
   * Index (in the messages array) of the first message kept verbatim.
   * 0 means everything was kept (summarized all — shouldn't normally happen).
   * The caller maps this back to a session entry ID via session.entryIdAtMessageIndex().
   */
  keptFromIndex: number
}

/**
 * Perform a full compaction of `messages`:
 *  1. Determine cut point (keep ~keepRecentTokens of recent history)
 *  2. Send the older messages to the LLM for summarization
 *  3. Append file-operation XML tags to the summary
 *  4. Return summary + tokensBefore + keptFromIndex
 *
 * The caller is responsible for calling `session.compact(...)` and rebuilding the harness.
 */
export async function compactMessages(
  messages: Message[],
  provider: Provider,
  model: string,
  settings: CompactionSettings,
  previousSummary?: string,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const tokensBefore = estimateContextTokens(messages)

  const cutIndex = findCutPoint(messages, settings.keepRecentTokens)
  const toSummarize = messages.slice(0, cutIndex)

  // If there's nothing to summarize (everything fits in keepRecentTokens), still
  // produce a fresh summary of ALL messages so the compaction entry is useful.
  const summarizeTarget = toSummarize.length > 0 ? toSummarize : messages

  // Extract file ops from the messages we're summarizing
  const ops = createFileOps()
  extractFileOpsFromMessages(summarizeTarget, ops)

  let summary = await generateSummary(summarizeTarget, provider, model, previousSummary, signal)

  // Append file op tags (Pi pattern)
  summary += formatFileOps(ops)

  return { summary, tokensBefore, keptFromIndex: cutIndex }
}
