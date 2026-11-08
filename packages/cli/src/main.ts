#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { ProviderRegistry, type ProviderName, calculateCost, getModel } from "@recode/ai"
import { AgentHarness, Session, DEFAULT_TOOLS, generateSummary } from "@recode/agent"
import { Renderer } from "./tui/renderer.js"
import { InputState, parseKey } from "./tui/input.js"
import { renderChatPane, maxScrollOffset, type ChatMessage } from "./tui/components/chat-pane.js"
import { renderStatusBar, invalidateGitBranchCache } from "./tui/components/status-bar.js"
import { renderInputBox } from "./tui/components/input-box.js"
import { renderPendingMessages, type PendingMessage } from "./tui/components/pending-messages.js"
import {
  renderCommandPalette, filteredCommands, makePaletteState,
  type CommandPaletteState,
} from "./tui/components/command-palette.js"
import { handleCommand } from "./commands.js"
import { T, stripAnsi } from "./tui/ansi.js"
import { loadSettings, type RecodeSettings } from "./settings.js"
import { loadProjectContextFiles } from "./context-files.js"

const SESSIONS_DIR  = join(homedir(), ".recode", "sessions")
const HISTORY_FILE  = join(homedir(), ".recode", "history.txt")

// ---------------------------------------------------------------------------
// Spinner frames (Pi-style braille)
// ---------------------------------------------------------------------------
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const SPINNER_INTERVAL_MS = 80

/**
 * OS-level progress indicator (Windows Terminal / iTerm2 / VTE).
 * State 0 = off, 3 = indeterminate spinner.
 * Silently ignored by terminals that don't support it.
 */
function setTerminalProgress(active: boolean): void {
  // OSC 9;4 -- Windows Terminal progress state
  // 0 = remove indicator, 3 = indeterminate
  process.stdout.write(active ? "\x1b]9;4;3;0\x07" : "\x1b]9;4;0;0\x07")
}

// ---------------------------------------------------------------------------
// #5 -- Relative time formatter (Pi-style: "2m", "3h", "5d", "2w", "1mo")
// ---------------------------------------------------------------------------
function formatRelativeTime(timestamp: number): string {
  const diffMs   = Date.now() - timestamp
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHrs  = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffMins < 1)   return "now"
  if (diffMins < 60)  return `${diffMins}m`
  if (diffHrs  < 24)  return `${diffHrs}h`
  if (diffDays < 7)   return `${diffDays}d`
  if (diffDays < 30)  return `${Math.floor(diffDays / 7)}w`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`
  return `${Math.floor(diffDays / 365)}y`
}

function buildSystemPrompt(
  contextFiles: Array<{ path: string; content: string }> = [],
  appendExtra?: string,
): string {
  const platform = process.platform  // "win32", "linux", "darwin"
  const cwd = process.cwd()
  const shell = platform === "win32" ? "Git Bash (bash on Windows -- use Windows-style paths like C:\\...)" : "bash"

  let prompt = `You are Recode, an expert coding assistant running in the terminal.
You help users write, read, edit, debug, and understand code across any language or framework.
You have access to tools to read/write files, run shell commands, search code, and more.
Always prefer using tools to verify your answers rather than guessing. Think step by step.
When editing code, read the file first, then make targeted edits using the edit tool.

Environment:
- Platform: ${platform}
- Shell: ${shell}
- Working directory: ${cwd}
${platform === "win32" ? "- Use Windows absolute paths (e.g. C:\\Users\\...) with your file tools. Shell commands run in Git Bash so forward slashes also work." : ""}
When asked to summarize or compact the conversation, write a dense technical summary that:
- Captures every file edited, command run, and decision made
- Lists open questions and next steps
- Is structured so another instance of you can continue seamlessly`

  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n"
    for (const { path, content } of contextFiles) {
      prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`
    }
    prompt += "</project_context>"
  }

  if (appendExtra) {
    prompt += `\n\n${appendExtra.trim()}`
  }

  return prompt
}

async function loadEnv(): Promise<void> {
  const envPath = join(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  try {
    const text = await readFile(envPath, "utf-8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const idx = trimmed.indexOf("=")
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
      if (key && !process.env[key]) process.env[key] = val
    }
  } catch { /* ignore */ }
}

async function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"] })
      proc.stdin?.write(text)
      proc.stdin?.end()
      proc.on("close", (code) => resolve(code === 0))
      proc.on("error", () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/**
 * Ask the LLM to produce a compact summary of the current session.
 *
 * Uses generateSummary() directly -- bypasses harness.prompt() entirely so the
 * summarisation request is NEVER added to the session history and cannot
 * accidentally trigger a second auto-compaction.
 */
async function generateCompactSummary(
  harness: AgentHarness,
  session: Session,
  previousSummary?: string,
): Promise<string> {
  const messages = session.messages()
  if (messages.length === 0) return "No conversation to summarize."

  return generateSummary(
    messages,
    harness.getProvider(),
    harness.getModel(),
    previousSummary,
  )
}

// ---------------------------------------------------------------------------
// CLI flag parser  (no external deps)
// ---------------------------------------------------------------------------
interface CliFlags {
  json: boolean
  noSession: boolean
  model: string | undefined
  tools: string | undefined           // comma-separated list
  appendSystemPrompt: string | undefined  // path to a file
  prompt: string | undefined          // positional argument
}

function parseCliFlags(): CliFlags {
  const flags: CliFlags = {
    json:               false,
    noSession:          false,
    model:              undefined,
    tools:              undefined,
    appendSystemPrompt: undefined,
    prompt:             undefined,
  }

  // Skip argv[0] (bun/node) and argv[1] (script path)
  const args = process.argv.slice(2)
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === "--json") {
      flags.json = true
    } else if (arg === "--no-session") {
      flags.noSession = true
    } else if (arg === "--model" && args[i + 1]) {
      flags.model = args[++i]
    } else if (arg === "--tools" && args[i + 1]) {
      flags.tools = args[++i]
    } else if (arg === "--append-system-prompt" && args[i + 1]) {
      flags.appendSystemPrompt = args[++i]
    } else if (!arg.startsWith("-")) {
      // First non-flag arg is the prompt
      flags.prompt = arg
    }
    i++
  }

  return flags
}

// ---------------------------------------------------------------------------
// JSON / headless mode
// Emits JSONL to stdout.  Used when recode is invoked as a sub-agent.
// Line format:  { "type": "...", ...fields }
//
//   { type: "text_delta",    delta: "..." }
//   { type: "tool_call",     name: "...", input: {...} }
//   { type: "tool_result",   name: "...", result: "...", isError: bool }
//   { type: "turn_end",      usage: {...} }
//   { type: "agent_end",     reason: "done"|"max_turns"|"interrupted"|"error" }
//   { type: "error",         message: "..." }
// ---------------------------------------------------------------------------
function emitJsonl(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

async function runJsonMode(flags: CliFlags): Promise<void> {
  await loadEnv()

  const settings = await loadSettings()
  const contextFiles = loadProjectContextFiles(process.cwd())

  const providerName: ProviderName =
    (process.env["RECODE_PROVIDER"] as ProviderName | undefined) ??
    (settings.provider as ProviderName | undefined) ??
    "anthropic"
  const registry = new ProviderRegistry()
  const model    = flags.model ?? process.env["RECODE_MODEL"] ?? settings.model ?? registry.defaultModel(providerName)

  // Build tool list (subset if --tools specified)
  let tools = DEFAULT_TOOLS
  if (flags.tools) {
    const allowed = new Set(flags.tools.split(",").map((t) => t.trim()))
    tools = DEFAULT_TOOLS.filter((t) => allowed.has(t.definition.name))
  }

  // Build system prompt
  let appendExtra: string | undefined
  if (flags.appendSystemPrompt) {
    try {
      appendExtra = await readFile(flags.appendSystemPrompt, "utf-8")
    } catch (e) {
      emitJsonl({ type: "error", message: `Could not read --append-system-prompt: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  if (settings.appendSystemPrompt) {
    appendExtra = appendExtra ? `${appendExtra}\n\n${settings.appendSystemPrompt}` : settings.appendSystemPrompt
  }
  const systemPrompt = buildSystemPrompt(contextFiles, appendExtra)

  // Session: ephemeral (no persistence) when --no-session
  const session = await Session.createEphemeral()

  const harness = new AgentHarness(
    registry.get(providerName),
    { provider: providerName, model, system: systemPrompt, tools, maxTurns: 50 },
    session,
  )

  const prompt = flags.prompt ?? ""
  if (!prompt) {
    emitJsonl({ type: "error", message: "No prompt provided (pass as positional argument)" })
    emitJsonl({ type: "agent_end", reason: "error" })
    process.exit(1)
  }

  // Handle SIGTERM gracefully
  process.on("SIGTERM", () => { harness.abort() })

  try {
    for await (const event of harness.prompt(prompt)) {
      switch (event.type) {
        case "text_delta":
          emitJsonl({ type: "text_delta", delta: event.delta })
          break
        case "tool_call_start":
          emitJsonl({ type: "tool_call_start", id: event.id, name: event.name })
          break
        case "tool_result":
          emitJsonl({ type: "tool_result", name: event.name, result: event.result, isError: event.isError })
          break
        case "turn_end":
          if (event.usage) emitJsonl({ type: "turn_end", usage: event.usage })
          break
        case "agent_end":
          emitJsonl({ type: "agent_end", reason: event.reason })
          break
        case "error":
          emitJsonl({ type: "error", message: event.error.message })
          break
        default:
          break  // thinking_delta, tool_call_delta, etc. -- not forwarded
      }
    }
  } catch (err) {
    emitJsonl({ type: "error", message: err instanceof Error ? err.message : String(err) })
    emitJsonl({ type: "agent_end", reason: "error" })
    process.exit(1)
  }
}

async function main(): Promise<void> {
  // ── Parse flags early so --json can skip the TUI entirely ──────────────
  const flags = parseCliFlags()

  if (flags.json) {
    await runJsonMode(flags)
    process.exit(0)
  }

  await loadEnv()

  const settings = await loadSettings()
  const contextFiles = loadProjectContextFiles(process.cwd())

  let providerName: ProviderName =
    (process.env["RECODE_PROVIDER"] as ProviderName | undefined) ??
    (settings.provider as ProviderName | undefined) ??
    "anthropic"
  const registry = new ProviderRegistry()
  let model = process.env["RECODE_MODEL"] || settings.model || registry.defaultModel(providerName)

  // ── Session bootstrap: auto-resume last session for this cwd (Pi pattern) ──
  let sessionId: string
  let sessionName: string | undefined
  let session: Session
  let isResumed = false

  const lastId = await Session.findLastForCwd(SESSIONS_DIR)
  if (lastId) {
    session    = await Session.loadFromCwd(SESSIONS_DIR, lastId)
    sessionId  = lastId
    sessionName = session.meta.name
    isResumed  = session.entryCount() > 0
  } else {
    sessionId = crypto.randomUUID()
    session   = await Session.create(SESSIONS_DIR, sessionId)
  }

  function buildHarness(): AgentHarness {
    const contextWindow = getModel(model)?.contextWindow ?? 0
    return new AgentHarness(
      registry.get(providerName),
      { provider: providerName, model, system: buildSystemPrompt(contextFiles, settings.appendSystemPrompt), tools: DEFAULT_TOOLS, maxTurns: 50 },
      session,
      {
        contextWindow,
        ...(settings.compaction ? { compaction: settings.compaction } : {}),
        ...(settings.retry ? { retry: settings.retry } : {}),
      },
    )
  }

  let harness = buildHarness()

  const renderer   = new Renderer()
  const inputState = new InputState()
  const messages: ChatMessage[] = []
  let streamingText        = ""
  let thinkingText         = ""
  let isRunning            = false
  let activitySpinnerFrame = 0
  let activitySpinnerTimer: ReturnType<typeof setInterval> | undefined
  let inputTokens          = 0
  let outputTokens         = 0
  let cacheReadTokens      = 0
  let cacheWriteTokens     = 0
  let totalCostUsd         = 0
  let scrollOffset         = 0
  let isAutoCompacting         = false
  let palette                  = makePaletteState()
  /** Messages the user typed while auto-compaction was running -- flushed after compaction_end */
  const compactionQueuedMessages: Array<{ text: string; mode: "steer" | "prompt" }> = []
  /**
   * Pi-style pending messages panel: steer/followUp messages queued while the
   * agent is running.  Rendered above the input box, cleared when agent stops.
   */
  const pendingMessages: PendingMessage[] = []

  // ── Compaction spinner state ───────────────────────────────────────────
  /** Current label shown in the streaming-text slot during compaction */
  let compactionSpinnerLabel  = ""
  /** Current spinner frame index */
  let compactionSpinnerFrame  = 0
  /** setInterval handle for the spinner tick */
  let compactionSpinnerTimer: ReturnType<typeof setInterval> | undefined
  /**
   * The Esc handler that was active *before* compaction started.
   * We replace it with abort-compaction while compaction is running,
   * then restore it when compaction ends.
   */
  let savedEscapeHandler: (() => void) | undefined = undefined

  /**
   * When a manual /compact is in flight, this holds a callback that aborts it.
   * The isAutoCompacting Esc branch calls this so the manual path is cancellable
   * with the same key as auto-compaction.
   */
  let currentManualCompactionAbort: (() => void) | undefined = undefined

  // Restore persisted cumulative stats from session metadata on resume
  if (isResumed) {
    const m = session.meta
    inputTokens      = m.totalInputTokens      ?? 0
    outputTokens     = m.totalOutputTokens     ?? 0
    cacheReadTokens  = m.totalCacheReadTokens  ?? 0
    cacheWriteTokens = m.totalCacheWriteTokens ?? 0
    totalCostUsd     = m.totalCostUsd          ?? 0
  }

  // Load persisted input history
  await inputState.loadHistory(HISTORY_FILE)

  function syncActivitySpinner(): void {
    const shouldAnimate = isRunning || isAutoCompacting
    if (shouldAnimate && activitySpinnerTimer === undefined) {
      activitySpinnerFrame = 0
      activitySpinnerTimer = setInterval(() => {
        activitySpinnerFrame = (activitySpinnerFrame + 1) % SPINNER_FRAMES.length
        draw()
      }, SPINNER_INTERVAL_MS)
    } else if (!shouldAnimate && activitySpinnerTimer !== undefined) {
      clearInterval(activitySpinnerTimer)
      activitySpinnerTimer = undefined
      activitySpinnerFrame = 0
    }
  }

  function draw(): void {
    syncActivitySpinner()
    renderer.render(buildFrame())
  }

  // ── Compaction spinner helpers ──────────────────────────────────────────

  /**
   * Start the spinner animation for a compaction operation.
   * @param reason  "manual" → "Compacting context…"  |  "auto" → "Auto-compacting…"
   */
  function startCompactionSpinner(reason: "manual" | "auto" | "overflow"): void {
    const baseLabel = reason === "manual"
      ? "Compacting context"
      : reason === "overflow"
        ? "Compacting (context overflow)"
        : "Auto-compacting"
    const cancelHint = `${T.dim} (Esc to cancel)${T.reset}`

    compactionSpinnerFrame = 0
    compactionSpinnerLabel = `${T.orange}${SPINNER_FRAMES[0]} ${baseLabel}…${T.reset}${cancelHint}`

    // Tick the spinner frame every SPINNER_INTERVAL_MS
    compactionSpinnerTimer = setInterval(() => {
      compactionSpinnerFrame = (compactionSpinnerFrame + 1) % SPINNER_FRAMES.length
      compactionSpinnerLabel =
        `${T.orange}${SPINNER_FRAMES[compactionSpinnerFrame]} ${baseLabel}…${T.reset}${cancelHint}`
      streamingText = compactionSpinnerLabel
      draw()
    }, SPINNER_INTERVAL_MS)

    streamingText = compactionSpinnerLabel
    setTerminalProgress(true)
  }

  function stopCompactionSpinner(): void {
    if (compactionSpinnerTimer !== undefined) {
      clearInterval(compactionSpinnerTimer)
      compactionSpinnerTimer = undefined
    }
    compactionSpinnerLabel = ""
    setTerminalProgress(false)
  }

  /**
   * Install the Esc-to-cancel handler for compaction.
   * Saves whatever the "current" escape behaviour was and replaces it.
   */
  function installCompactionEscHandler(): void {
    // We don't have a formal "escape handler stack" -- instead we gate on
    // isAutoCompacting in the input handler.  The flag itself is enough;
    // this helper just documents the Pi pattern for future extension.
    savedEscapeHandler = undefined  // nothing to save in current architecture
  }

  function restoreEscHandler(): void {
    savedEscapeHandler = undefined
  }

  function addInfo(lines: string[]): void {
    for (const l of lines) messages.push({ role: "assistant", content: l })
    draw()
  }

  function addError(msg: string): void {
    messages.push({ role: "error", content: msg })
    draw()
  }

  /**
   * Rebuild the terminal chat history from session entries.
   * Called after a successful compaction to match Pi's behaviour: old messages
   * are cleared and the visible history is reconstructed from what the session
   * still holds (summary card + kept slice + post-compaction turns).
   */
  function rebuildChatFromSession(summary: string, tokensBefore: number): void {
    messages.length = 0
    // Insert the compaction summary card at the top
    messages.push({
      role: "compaction_summary",
      content: summary,
      tokensBefore,
      expanded: false,
    })
    // Rebuild message rows from the kept slice (post-compaction entries in session)
    for (const msg of session.messages()) {
      // Skip the synthetic summary wrapper injected by session.messages()
      if (msg.role === "user") {
        const textParts = msg.parts.filter((p) => p.type === "text")
        const resultParts = msg.parts.filter((p) => p.type === "tool_result")
        if (textParts.length > 0) {
          const text = textParts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")
          // Skip the synthetic <previous_context> wrapper
          if (!text.startsWith("<previous_context>")) {
            messages.push({ role: "user", content: text })
          }
        }
        for (const p of resultParts) {
          if (p.type === "tool_result") {
            messages.push({ role: "tool_result", content: p.content, isError: p.isError ?? false })
          }
        }
      } else if (msg.role === "assistant") {
        const text = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")
        if (text) messages.push({ role: "assistant", content: text })
      }
    }
  }

  // ── Retry countdown state ──────────────────────────────────────────────────
  let retryCountdownTimer: ReturnType<typeof setInterval> | undefined
  let retryCountdownEnd = 0

  function startRetryCountdown(attempt: number, maxAttempts: number, delayMs: number): void {
    retryCountdownEnd = Date.now() + delayMs
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryCountdownEnd - Date.now()) / 1000))
      streamingText = `${T.orange}⟳ Retrying (${attempt}/${maxAttempts}) in ${remaining}s… ${T.dim}(Esc to cancel)${T.reset}`
      draw()
      if (remaining === 0) stopRetryCountdown()
    }
    update()
    retryCountdownTimer = setInterval(update, 250)
  }

  function stopRetryCountdown(): void {
    if (retryCountdownTimer !== undefined) {
      clearInterval(retryCountdownTimer)
      retryCountdownTimer = undefined
    }
  }

  function buildFrame(): string[] {
    const rows = renderer.rows
    const cols = renderer.cols
    const contextWindow = getModel(model)?.contextWindow ?? 0
    const statusLines = renderStatusBar({
      provider: providerName, model,
      sessionId: sessionName ?? sessionId.slice(0, 8),
      isRunning,
      isAutoCompacting,
      spinnerFrame: SPINNER_FRAMES[activitySpinnerFrame] ?? "⠋",
      inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens,
      totalCostUsd,
      contextWindow,
      width: cols,
      scrollOffset,
      cwd: process.cwd(),
    })
    const pendingLines   = renderPendingMessages(pendingMessages, cols)
    const inputLines     = renderInputBox({ value: inputState.value, cursorPos: inputState.cursor, isRunning, width: cols, placeholder: "Ask anything…", pendingCount: pendingMessages.length })
    const paletteLines   = palette.open
      ? renderCommandPalette(inputState.value, palette.selectedIndex, cols)
      : []
    // overhead = status + pending + input + palette lines
    const overhead    = statusLines.length + pendingLines.length + inputLines.length + paletteLines.length
    const chatHeight  = Math.max(1, rows - overhead)
    const chatLines   = renderChatPane(messages, cols, chatHeight, streamingText, scrollOffset, thinkingText)
    const padded = chatLines.length < chatHeight
      ? [...Array(chatHeight - chatLines.length).fill(""), ...chatLines]
      : chatLines
    return [...padded, ...statusLines, ...pendingLines, ...paletteLines, ...inputLines]
  }

  function currentChatHeight(): number {
    const paletteLines = palette.open
      ? renderCommandPalette(inputState.value, palette.selectedIndex, renderer.cols).length
      : 0
    return Math.max(1, renderer.rows - 5 - paletteLines)
  }

  function scrollBy(delta: number): void {
    const chatHeight = currentChatHeight()
    const max = maxScrollOffset(messages, renderer.cols, chatHeight, streamingText, thinkingText)
    scrollOffset = Math.max(0, Math.min(scrollOffset + delta, max))
    renderer.flushNow(buildFrame())
  }

  function scrollToBottom(): void {
    scrollOffset = 0
    renderer.flushNow(buildFrame())
  }

  function scrollToTop(): void {
    const chatHeight = currentChatHeight()
    scrollOffset = maxScrollOffset(messages, renderer.cols, chatHeight, streamingText, thinkingText)
    renderer.flushNow(buildFrame())
  }

  async function runAgent(userText: string): Promise<void> {
    isRunning    = true
    streamingText = ""
    thinkingText  = ""
    scrollOffset  = 0
    draw()

    let assistantText = ""

    try {
      for await (const event of harness.prompt(userText)) {
        if (event.type === "thinking_delta") {
          thinkingText += event.delta
          draw()
        } else if (event.type === "text_delta") {
          thinkingText   = ""
          assistantText += event.delta
          streamingText  = assistantText
          draw()
        } else if (event.type === "tool_call_start") {
          if (assistantText.trim()) {
            messages.push({ role: "assistant", content: assistantText.trim() })
            assistantText = ""
          }
          streamingText = `▸ calling ${event.name}…`
          draw()
        } else if (event.type === "tool_result") {
          streamingText = ""
          messages.push({ role: "tool_result", content: event.result, toolName: event.name, isError: event.isError })
          draw()
        } else if (event.type === "turn_end") {
          if (event.usage) {
            inputTokens      += event.usage.inputTokens
            outputTokens     += event.usage.outputTokens
            cacheReadTokens  += event.usage.cacheReadTokens
            cacheWriteTokens += event.usage.cacheWriteTokens
            const cost = calculateCost(model, event.usage)
            if (cost) totalCostUsd += cost.total
            // Feed live token counts back into the harness for threshold checks
            harness.updateContextTokens(inputTokens, cacheReadTokens, cacheWriteTokens)
            // Persist cumulative stats so they survive resume
            session.updateCumulativeStats({
              totalCostUsd, totalInputTokens: inputTokens, totalOutputTokens: outputTokens,
              totalCacheReadTokens: cacheReadTokens, totalCacheWriteTokens: cacheWriteTokens,
            }).catch(() => { /* best-effort */ })
          }
        } else if (event.type === "agent_end") {
          if (assistantText.trim()) {
            messages.push({ role: "assistant", content: assistantText.trim() })
            assistantText = ""
          }
          streamingText = ""
          thinkingText  = ""
          isRunning     = false
          // Clear pending panel -- agent has stopped, messages are either injected or moot
          pendingMessages.length = 0
          draw()

        // ── Auto-compaction events (emitted by AgentHarness after agent_end) ──

        } else if (event.type === "compaction_start") {
          // Block normal input -- user messages typed now go to queue
          isAutoCompacting = true
          installCompactionEscHandler()
          startCompactionSpinner(event.reason)
          draw()

        } else if (event.type === "compaction_end") {
          stopCompactionSpinner()
          restoreEscHandler()
          isAutoCompacting = false
          streamingText    = ""
          thinkingText     = ""

          if (event.aborted) {
            // Restore any queued messages back to the editor so the user doesn't lose them
            if (pendingMessages.length > 0) {
              const all = pendingMessages.splice(0).map((m) => m.text)
              compactionQueuedMessages.length = 0
              const combined = [inputState.value, ...all].filter(Boolean).join("\n\n")
              inputState.setValue(combined)
            }
            messages.push({
              role: "assistant",
              content: `${T.dim}⠿ Compaction cancelled.${T.reset}`,
            })
          } else if (event.success) {
            // Reset counters and rebuild harness with fresh context
            inputTokens      = 0; outputTokens     = 0
            cacheReadTokens  = 0; cacheWriteTokens = 0
            totalCostUsd     = 0
            harness          = buildHarness()

            // Pi pattern: rebuild visible chat from session (clears old history)
            rebuildChatFromSession(event.summary, event.tokensBefore)
            pendingMessages.length = 0
          } else {
            messages.push({ role: "error", content: `Auto-compact failed: ${event.error.message}` })
            pendingMessages.length = 0
          }

          draw()

          // Flush queued messages after compaction completes.
          // For overflow compaction (willRetry=true) the harness will continue
          // the loop internally -- route typed messages as steer() calls.
          // For normal auto-compaction route as new prompt() calls.
          if (!event.aborted && compactionQueuedMessages.length > 0) {
            const queued = compactionQueuedMessages.splice(0)
            if (!event.aborted && event.success && event.willRetry) {
              // harness is still running (overflow retry) -- inject as steer
              for (const q of queued) {
                if (q.mode === "steer") harness.steer(q.text)
                else { messages.push({ role: "user", content: q.text }); draw(); await runAgent(q.text) }
              }
            } else {
              for (const q of queued) {
                messages.push({ role: "user", content: q.text })
                draw()
                await runAgent(q.text)
              }
            }
          }

        } else if (event.type === "retry_start") {
          startRetryCountdown(event.attempt, event.maxAttempts, event.delayMs)
        } else if (event.type === "retry_end") {
          stopRetryCountdown()
          streamingText = ""
        } else if (event.type === "error") {
          messages.push({ role: "error", content: event.error.message })
          streamingText = ""
        }
      }
    } catch (err) {
      messages.push({ role: "error", content: err instanceof Error ? err.message : String(err) })
      streamingText = ""
      isRunning = false
    }

    // Ensure isRunning is false even if agent_end wasn't reached (e.g. early return)
    isRunning = false
    draw()
  }

  // ---------------------------------------------------------------------------
  // Palette helpers
  // ---------------------------------------------------------------------------
  function paletteOpen(): void  { palette.open = true;  palette.selectedIndex = 0 }
  function paletteClose(): void { palette.open = false; palette.selectedIndex = 0 }

  function paletteUp(): void {
    const cmds = filteredCommands(inputState.value)
    if (cmds.length === 0) return
    palette.selectedIndex = (palette.selectedIndex - 1 + cmds.length) % cmds.length
  }

  function paletteDown(): void {
    const cmds = filteredCommands(inputState.value)
    if (cmds.length === 0) return
    palette.selectedIndex = (palette.selectedIndex + 1) % cmds.length
  }

  /** Confirm the highlighted command: fill input with "/name " and close palette */
  function paletteConfirm(): string | null {
    const cmds = filteredCommands(inputState.value)
    const cmd  = cmds[palette.selectedIndex]
    paletteClose()
    if (!cmd) return null
    return `/${cmd.name}`
  }

  async function handleInput(key: ReturnType<typeof parseKey>): Promise<void> {
    // ⌥T -- toggle expand/collapse on the most recent compaction summary card
    if (key.type === "alt_t") {
      // Walk backwards to find the last compaction_summary message
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!
        if (m.role === "compaction_summary") {
          m.expanded = !m.expanded
          draw()
          break
        }
      }
      return
    }

    if (key.type === "ctrl_c") {
      if (palette.open) { paletteClose(); draw(); return }
      // Ctrl-C during compaction: cancel the compaction (same as Esc), not the app
      if (isAutoCompacting) {
        harness.abortCompaction()
        currentManualCompactionAbort?.()
        return
      }
      if (isRunning) {
        harness.abort()
        stopRetryCountdown()
        // Restore any queued messages back to the editor so the user doesn't lose them
        if (pendingMessages.length > 0) {
          const all = pendingMessages.splice(0).map((m) => m.text)
          const combined = [inputState.value, ...all].filter(Boolean).join("\n\n")
          inputState.setValue(combined)
        }
        messages.push({ role: "error", content: "Interrupted." })
        isRunning    = false
        streamingText = ""
        draw()
      } else {
        shutdown()
      }
      return
    }
    if (key.type === "ctrl_d") { if (!isRunning) shutdown(); return }
    if (key.type === "ctrl_l") { renderer.invalidate(); draw(); return }

    // Scroll keys work even while agent is running
    if (key.type === "page_up")     { scrollBy(Math.max(1, renderer.rows - 5)); return }
    if (key.type === "page_down")   { scrollBy(-(Math.max(1, renderer.rows - 5))); return }
    if (key.type === "scroll_up")   { scrollBy(3); return }
    if (key.type === "scroll_down") { scrollBy(-3); return }

    // While auto-compacting, queue typed input rather than discarding it
    if (isAutoCompacting) {
      if (key.type === "escape") {
        // Esc during compaction → cancel the compaction (Ctrl-C is handled above)
        harness.abortCompaction()
        currentManualCompactionAbort?.()
        return
      } else if (key.type === "enter") {
        const text = inputState.submit()
        if (text && !text.startsWith("/")) {
          compactionQueuedMessages.push({ text, mode: "steer" })
          pendingMessages.push({ text, mode: "steer" })
          draw()
        }
        return
      } else if (key.type === "alt_enter") {
        const text = inputState.submit()
        if (text && !text.startsWith("/")) {
          compactionQueuedMessages.push({ text, mode: "prompt" })
          pendingMessages.push({ text, mode: "followUp" })
          draw()
        }
        return
      } else if (key.type === "alt_up") {
        // Dequeue: restore pending back to editor
        if (pendingMessages.length > 0) {
          const all = pendingMessages.splice(0).map((m) => m.text)
          compactionQueuedMessages.length = 0
          const combined = [inputState.value, ...all].filter(Boolean).join("\n\n")
          inputState.setValue(combined)
          draw()
        }
        return
      } else if (key.type === "char") {
        inputState.insert(key.char); draw()
        return
      } else if (key.type === "backspace") {
        inputState.backspace(); draw()
        return
      }
      return
    }

    // While agent is running: allow full editing + Enter to steer, Alt+Enter to follow-up, Alt+↑ to dequeue
    if (isRunning) {
      if (key.type === "char") {
        inputState.insert(key.char); draw()
      } else if (key.type === "backspace") {
        inputState.backspace(); draw()
      } else if (key.type === "delete") {
        inputState.deleteForward(); draw()
      } else if (key.type === "left") {
        inputState.moveLeft(); draw()
      } else if (key.type === "right") {
        inputState.moveRight(); draw()
      } else if (key.type === "home") {
        inputState.moveHome(); draw()
      } else if (key.type === "end") {
        inputState.moveEnd(); draw()
      } else if (key.type === "paste") {
        inputState.insertText(key.text); draw()
      } else if (key.type === "ctrl_u") {
        inputState.clearLine(); draw()
      } else if (key.type === "ctrl_w") {
        inputState.deleteWord(); draw()
      } else if (key.type === "enter") {
        // Enter → steer (injects after current tool-call turn)
        const text = inputState.submit()
        if (text && !text.startsWith("/")) {
          harness.steer(text)
          pendingMessages.push({ text, mode: "steer" })
          draw()
        }
      } else if (key.type === "alt_enter") {
        // Alt+Enter → followUp (injects only when agent would otherwise stop)
        const text = inputState.submit()
        if (text && !text.startsWith("/")) {
          harness.followUp(text)
          pendingMessages.push({ text, mode: "followUp" })
          draw()
        }
      } else if (key.type === "alt_up") {
        // Alt+↑ → dequeue: restore all pending messages back into the editor
        if (pendingMessages.length > 0) {
          const all = pendingMessages.splice(0).map((m) => m.text)
          harness.clearAllQueues()
          const combined = [inputState.value, ...all].filter(Boolean).join("\n\n")
          inputState.setValue(combined)
          draw()
        }
      }
      return
    }

    // ── Palette-mode key overrides ─────────────────────────────────────────
    if (palette.open) {
      if (key.type === "escape") { paletteClose(); draw(); return }
      if (key.type === "up")     { paletteUp();    draw(); return }
      if (key.type === "down")   { paletteDown();  draw(); return }
      if (key.type === "tab")    { paletteDown();  draw(); return }

      if (key.type === "enter") {
        const chosen = paletteConfirm()
        if (chosen) {
          // Commands with arguments: put text in input and let user complete
          const needsArg = ["resume", "name", "export", "model", "provider"].includes(chosen.slice(1))
          if (needsArg) {
            inputState.setValue(chosen + " ")
            draw()
            return
          }
          // Self-contained commands: execute immediately
          inputState.setValue(chosen)
        }
        // Fall through to normal Enter handling below with the chosen value
      } else if (key.type === "backspace") {
        inputState.backspace()
        // Re-evaluate: if input no longer starts with "/" close palette
        if (!inputState.value.startsWith("/")) paletteClose()
        else { palette.selectedIndex = 0 }
        draw()
        return
      } else if (key.type === "char") {
        inputState.insert(key.char)
        palette.selectedIndex = 0
        if (!inputState.value.startsWith("/")) paletteClose()
        draw()
        return
      } else {
        // Any other key (arrows handled above): fall through
      }

      if (key.type !== "enter") { draw(); return }
    }

    switch (key.type) {
      case "char":
        inputState.insert(key.char)
        // Open palette when "/" is the entire input
        if (inputState.value === "/") paletteOpen()
        else if (inputState.value.startsWith("/") && !palette.open) paletteOpen()
        else if (!inputState.value.startsWith("/")) paletteClose()
        break
      // #8 -- bracketed paste: insert as single text block
      case "paste":     inputState.insertText(key.text); paletteClose(); break
      case "backspace":
        inputState.backspace()
        if (!inputState.value.startsWith("/")) paletteClose()
        else if (inputState.value === "/")     { paletteOpen(); palette.selectedIndex = 0 }
        break
      case "delete":    inputState.deleteForward(); break
      case "left":      inputState.moveLeft(); break
      case "right":     inputState.moveRight(); break
      case "home":      inputState.moveHome(); break
      case "end":
        if (scrollOffset > 0) { scrollToBottom(); return }
        inputState.moveEnd()
        break
      case "up":
        if (!inputState.value) { scrollBy(3); return }
        inputState.historyUp()
        break
      case "down":
        if (scrollOffset > 0) { scrollBy(-3); return }
        inputState.historyDown()
        break
      case "ctrl_u": inputState.clearLine(); paletteClose(); break
      case "ctrl_w": inputState.deleteWord(); if (!inputState.value.startsWith("/")) paletteClose(); break
      case "escape":   paletteClose(); break

      case "enter": {
        paletteClose()
        const text = inputState.submit()
        if (!text) break
        const cmd = handleCommand(text)

        if (cmd.type === "not_a_command") {
          scrollOffset = 0
          messages.push({ role: "user", content: text })
          draw()
          await runAgent(text)

        } else if (cmd.type === "quit") {
          shutdown()

        } else if (cmd.type === "show_output") {
          addInfo(cmd.lines)

        } else if (cmd.type === "clear_chat") {
          // Clear UI display AND reset agent context so the model starts fresh
          messages.length = 0
          const newSession = await Session.create(SESSIONS_DIR, crypto.randomUUID())
          session          = newSession
          sessionId        = newSession.meta.id
          harness          = buildHarness()
          inputTokens      = 0; outputTokens     = 0
          cacheReadTokens  = 0; cacheWriteTokens = 0
          totalCostUsd     = 0
          draw()

        } else if (cmd.type === "compact") {
          // ── Pi-style /compact: emit compaction_start/end events so the same
          //    UI path as auto-compaction handles everything (spinner, Esc, card)
          isAutoCompacting = true
          installCompactionEscHandler()
          startCompactionSpinner("manual")
          draw()

          // Create a dedicated abort controller for the manual compact
          const manualAbort = new AbortController()
          const manualSignal = manualAbort.signal

          // Attach Esc-to-cancel: we need to allow the input handler's
          // isAutoCompacting branch to call harness.abortCompaction() -- but
          // for /compact the harness doesn't own the operation, so we track
          // it here.  We stash a cancel callback that the Esc handler can reach.
          // Simplest approach: store it on a closure variable checked in input.
          // We'll handle it by having the "escape during isAutoCompacting" path
          // also call manualAbort.abort() -- achieved via a module-level ref.
          currentManualCompactionAbort = () => manualAbort.abort()

          try {
            const previousSummary = session.getPreviousSummary()
            const tokensBefore    = inputTokens + cacheReadTokens + cacheWriteTokens

            // Run the LLM summarisation in a race against cancellation
            const ABORTED = Symbol("aborted")
            const cancelRace = new Promise<never>((_, reject) => {
              if (manualSignal.aborted) { reject(ABORTED); return }
              manualSignal.addEventListener("abort", () => reject(ABORTED), { once: true })
            })

            let summary: string
            try {
              summary = await Promise.race([
                generateCompactSummary(harness, session, previousSummary),
                cancelRace,
              ])
            } catch (raceErr) {
              if (raceErr === ABORTED) {
                // User cancelled
                stopCompactionSpinner()
                restoreEscHandler()
                isAutoCompacting = false
                currentManualCompactionAbort = undefined
                streamingText = ""
                messages.push({ role: "assistant", content: `${T.dim}⠿ Compaction cancelled.${T.reset}` })
                draw()
                break
              }
              throw raceErr
            }

            const result = await harness.compact(summary, tokensBefore)

            stopCompactionSpinner()
            restoreEscHandler()
            isAutoCompacting = false
            currentManualCompactionAbort = undefined
            streamingText = ""

            if (!result.ok) {
              addError(`Compact failed: ${result.error.message}`)
            } else {
              // Reset LLM context counters and rebuild harness
              inputTokens      = 0; outputTokens     = 0
              cacheReadTokens  = 0; cacheWriteTokens = 0
              totalCostUsd     = 0
              harness = buildHarness()
              // Insert the same collapsible compaction summary card as auto-compaction
              messages.push({
                role: "compaction_summary",
                content: summary,
                tokensBefore,
                expanded: false,
              })
              draw()
            }
          } catch (err) {
            stopCompactionSpinner()
            restoreEscHandler()
            isAutoCompacting = false
            currentManualCompactionAbort = undefined
            streamingText = ""
            addError(`Compact failed: ${err instanceof Error ? err.message : String(err)}`)
          }

        } else if (cmd.type === "set_model") {
          model  = cmd.model
          harness = buildHarness()
          addInfo([`Model → ${model}`])

        } else if (cmd.type === "set_provider") {
          providerName = cmd.provider
          model        = cmd.model
          harness      = buildHarness()
          addInfo([`Provider → ${providerName}   Model → ${model}`])

        } else if (cmd.type === "new_session") {
          sessionId        = crypto.randomUUID()
          sessionName      = undefined
          session          = await Session.create(SESSIONS_DIR, sessionId)
          harness          = buildHarness()
          inputTokens      = 0; outputTokens     = 0
          cacheReadTokens  = 0; cacheWriteTokens = 0
          totalCostUsd     = 0
          messages.length  = 0
          invalidateGitBranchCache()
          addInfo([
            `${T.green}New session started.${T.reset}`,
            `ID: ${sessionId}`,
            `${T.dim}This session will auto-resume next time you open recode here.${T.reset}`,
          ])

        } else if (cmd.type === "resume_session") {
          try {
            // Try cwd-scoped first, fall back to flat layout for backwards compat
            let loaded: Session
            try {
              loaded = await Session.loadFromCwd(SESSIONS_DIR, cmd.sessionId)
            } catch {
              loaded = await Session.load(SESSIONS_DIR, cmd.sessionId)
            }
            sessionId   = cmd.sessionId
            sessionName = loaded.meta.name
            session     = loaded
            harness     = buildHarness()
            messages.length = 0
            // Restore persisted stats from the resumed session
            const rm = loaded.meta
            inputTokens      = rm.totalInputTokens      ?? 0
            outputTokens     = rm.totalOutputTokens     ?? 0
            cacheReadTokens  = rm.totalCacheReadTokens  ?? 0
            cacheWriteTokens = rm.totalCacheWriteTokens ?? 0
            totalCostUsd     = rm.totalCostUsd          ?? 0
            invalidateGitBranchCache()
            const count = session.entryCount()
            addInfo([
              `${T.green}Session resumed.${T.reset}`,
              `ID: ${sessionId}   ${count} entries loaded.`,
            ])
          } catch {
            addError(`Could not load session: ${cmd.sessionId}`)
          }

        } else if (cmd.type === "list_sessions") {
          const cwdMetas = await Session.listForCwd(SESSIONS_DIR)
          if (cwdMetas.length === 0) {
            addInfo(["No saved sessions for this directory."])
          } else {
            const rows = cwdMetas.map((m) => {
              const label   = m.name ? `"${m.name}"` : m.id.slice(0, 8)
              // #5 -- relative time (Pi-style)
              const relTime = formatRelativeTime(m.updatedAt)
              const cost    = m.totalCostUsd ? `  ${m.totalCostUsd.toFixed(3)}` : ""
              const cur     = m.id === sessionId ? "  ← current" : ""
              return `  ${label.padEnd(20)} ${relTime.padEnd(6)}${cost}${cur}`
            })
            addInfo([
              `Sessions for ${process.cwd()} (${cwdMetas.length}):`,
              "",
              ...rows,
              "",
              "Use /resume <id> to load one.",
            ])
          }

        } else if (cmd.type === "show_session_info") {
          const totalTokens    = inputTokens + outputTokens
          const contextWindow  = getModel(model)?.contextWindow ?? 0
          const ctxPct         = contextWindow > 0 ? ` (${((inputTokens + cacheReadTokens + cacheWriteTokens) / contextWindow * 100).toFixed(1)}% of ${contextWindow.toLocaleString()})` : ""
          const cacheHitRate   = (inputTokens + cacheReadTokens + cacheWriteTokens) > 0
            ? ` CH${((cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)) * 100).toFixed(1)}%` : ""
          addInfo([
            "Session info:",
            `  ID           ${sessionId}`,
            `  Name         ${sessionName ?? "(none)  use /name <text> to set"}`,
            `  Entries      ${session.entryCount()}`,
            `  Tokens       ↑${inputTokens.toLocaleString()} ↓${outputTokens.toLocaleString()}  total=${totalTokens.toLocaleString()}${ctxPct}`,
            `  Cache        R${cacheReadTokens.toLocaleString()} W${cacheWriteTokens.toLocaleString()}${cacheHitRate}`,
            `  Cost         ${totalCostUsd.toFixed(4)}`,
            `  Provider     ${providerName}`,
            `  Model        ${model}`,
            `  CWD          ${process.cwd()}`,
            `  ${T.dim}Sessions auto-resume when you reopen recode here.${T.reset}`,
          ])

        } else if (cmd.type === "set_name") {
          sessionName = cmd.name
          await session.setName(cmd.name)
          addInfo([`Session name set: ${sessionName}`])

        } else if (cmd.type === "export_session") {
          try {
            const exportPath = cmd.path ?? join(process.cwd(), `recode-session-${sessionId.slice(0, 8)}.txt`)
            const lines: string[] = [`Recode session export`, `ID: ${sessionId}`, ``, ``]
            for (const msg of messages) {
              if (msg.role === "user") {
                lines.push(`You: ${stripAnsi(msg.content)}`)
              } else if (msg.role === "assistant") {
                lines.push(`Recode: ${stripAnsi(msg.content)}`)
              } else if (msg.role === "tool_result") {
                lines.push(`[${msg.toolName ?? "tool"}]: ${stripAnsi(msg.content).slice(0, 500)}`)
              }
              lines.push("")
            }
            await writeFile(exportPath, lines.join("\n"), "utf-8")
            addInfo([`Session exported to: ${exportPath}`])
          } catch (err) {
            addError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
          }

        } else if (cmd.type === "copy_last") {
          const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
          if (!lastAssistant) {
            addInfo(["No assistant message to copy."])
          } else {
            const ok = await copyToClipboard(stripAnsi(lastAssistant.content))
            addInfo([ok ? "Copied to clipboard." : "Copy failed -- clip.exe not available."])
          }
        }

        break
      }
    }
    draw()
  }

  function shutdown(): void {
    renderer.exitAlt()
    process.stdout.write("\nBye!\n")
    process.exit(0)
  }

  if (!process.stdin.isTTY) {
    console.error("Error: recode must be run in an interactive terminal (stdin is not a TTY).")
    console.error("Run it directly with:  bun packages/cli/src/main.ts")
    process.exit(1)
  }

  renderer.enterAlt()
  draw()

  // Startup banner -- show whether we resumed an existing session
  if (isResumed) {
    addInfo([
      `${T.bold}${T.purple}◆ recode${T.reset}  ${T.muted}general purpose coding agent${T.reset}`,
      `${T.dim}Provider: ${providerName}   Model: ${model}${T.reset}`,
      `${T.green}↺ Resumed session${T.reset} ${T.dim}${sessionName ? `"${sessionName}"  ` : ""}#${sessionId.slice(0, 8)}  ${session.entryCount()} entries${T.reset}`,
      `${T.dim}Type /help for commands, /hotkeys for shortcuts, /new to start fresh.${T.reset}`,
      "",
    ])
  } else {
    addInfo([
      `${T.bold}${T.purple}◆ recode${T.reset}  ${T.muted}general purpose coding agent${T.reset}`,
      `${T.dim}Provider: ${providerName}   Model: ${model}${T.reset}`,
      `${T.dim}Type /help for commands, /hotkeys for shortcuts.${T.reset}`,
      "",
    ])
  }

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on("data", (data: Buffer) => {
    handleInput(parseKey(data)).catch((err) => {
      messages.push({ role: "error", content: String(err) })
      isRunning = false
      draw()
    })
  })

  process.on("SIGTERM", shutdown)
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1) })
