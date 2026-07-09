import { T, wordWrap, truncate, renderMarkdown, visibleWidth, padEnd } from "../ansi.js"

export type MessageRole = "user" | "assistant" | "tool_result" | "error" | "compaction_summary"

export interface ChatMessage {
  role: MessageRole
  content: string
  toolName?: string
  isError?: boolean
  /**
   * Populated only for role="compaction_summary".
   * Holds the number of tokens the context was reduced from.
   */
  tokensBefore?: number
  /**
   * Populated only for role="compaction_summary".
   * When true the full summary text is shown; otherwise only the header line.
   */
  expanded?: boolean
}

export function renderChatPane(
  messages: ChatMessage[],
  width: number,
  height: number,
  streamingText: string,
  scrollOffset = 0,
  thinkingText = "",
): string[] {
  const all: string[] = []

  for (const msg of messages) {
    all.push(...renderMessage(msg, width), "")
  }

  if (thinkingText) all.push(...renderThinking(thinkingText, width))
  if (streamingText) all.push(...renderMessage({ role: "assistant", content: streamingText }, width))

  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, all.length - height)))
  const end = all.length - clampedOffset
  const start = Math.max(0, end - height)
  return all.slice(start, end)
}

export function maxScrollOffset(messages: ChatMessage[], width: number, height: number, streamingText: string, thinkingText = ""): number {
  const all: string[] = []
  for (const msg of messages) all.push(...renderMessage(msg, width), "")
  if (thinkingText) all.push(...renderThinking(thinkingText, width))
  if (streamingText) all.push(...renderMessage({ role: "assistant", content: streamingText }, width))
  return Math.max(0, all.length - height)
}

function renderThinking(text: string, width: number): string[] {
  const cw = width - 6
  const lines: string[] = [`${T.purpleDim}⠿ thinking…${T.reset}`]
  const preview = text.slice(-200) // show last 200 chars while streaming
  for (const l of wordWrap(preview, cw)) {
    lines.push(`  ${T.dim}${l}${T.reset}`)
  }
  return lines
}

function renderMessage(msg: ChatMessage, width: number): string[] {
  const lines: string[] = []
  const cw = width - 4

  if (msg.role === "user") {
    lines.push(`${T.bold}${T.teal}You${T.reset}`)
    for (const l of wordWrap(msg.content, cw)) lines.push(`  ${T.white}${l}${T.reset}`)

  } else if (msg.role === "assistant") {
    lines.push(`${T.bold}${T.purple}◆ recode${T.reset}`)
    for (const l of renderMarkdown(msg.content, cw)) lines.push(`  ${l}`)

  } else if (msg.role === "tool_result") {
    const label = msg.toolName ? truncate(msg.toolName, 32) : "tool"
    if (msg.isError) {
      lines.push(`${T.red}✕ ${label}${T.reset}`)
    } else {
      lines.push(`${T.purpleDim}▸ ${T.muted}${label}${T.reset}`)
    }
    const outputLines = msg.content.split("\n").slice(0, 30)
    for (const l of outputLines) {
      lines.push(`  ${T.dim}${truncate(l, cw)}${T.reset}`)
    }
    if (msg.content.split("\n").length > 30) lines.push(`  ${T.faint}… (truncated)${T.reset}`)

  } else if (msg.role === "error") {
    lines.push(`${T.bold}${T.red}✕ error${T.reset}`)
    for (const l of wordWrap(msg.content, cw)) lines.push(`  ${T.red}${l}${T.reset}`)

  } else if (msg.role === "compaction_summary") {
    // ── Compaction summary card (Pi-style collapsible) ─────────────────────
    const tokenLabel = msg.tokensBefore
      ? `${T.dim}was ~${msg.tokensBefore.toLocaleString()} tokens${T.reset}`
      : ""
    const toggleHint = `${T.dim}(⌥T to ${msg.expanded ? "collapse" : "expand"})${T.reset}`
    const icon = `${T.orange}⠿${T.reset}`

    if (!msg.expanded) {
      // Collapsed: single-line header
      const header = `${icon} ${T.orange}Context compacted${T.reset}  ${tokenLabel}  ${toggleHint}`
      lines.push(header)
    } else {
      // Expanded: header + full summary
      const dividerWidth = Math.min(width - 2, 60)
      const divider = `${T.purpleMuted}${"─".repeat(dividerWidth)}${T.reset}`
      lines.push(`${icon} ${T.orange}${T.bold}Context compacted${T.reset}  ${tokenLabel}  ${toggleHint}`)
      lines.push(divider)
      for (const l of renderMarkdown(msg.content, cw)) lines.push(`  ${l}`)
      lines.push(divider)
    }
  }

  return lines
}
