import type { Message, Provider } from "@recode/ai"
import { userMessage, assistantMessage, type MessagePart, type ToolCallPart } from "@recode/ai"
import { agentLoop } from "./loop.js"
import { Session } from "./session.js"
import { type AgentConfig, type AgentEvent, type QueueMode, type Result, AgentHarnessError, ok, err } from "./types.js"
import {
  compactMessages,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./compaction.js"

// ---------------------------------------------------------------------------
// Retry settings
// ---------------------------------------------------------------------------

export interface RetrySettings {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
}

const RETRYABLE_PATTERN =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?error|fetch failed|timed?.?out|timeout/i

const NON_RETRYABLE_PATTERN =
  /context.window|too.long|context.length|max.tokens|401|unauthorized|invalid.api.key/i

/**
 * Context-overflow errors — these trigger compaction + retry rather than the
 * normal exponential-backoff retry path.  Mirrors Pi's isContextOverflow().
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context.window|too.long|context.length|prompt.too.long|context.*exceed|exceed.*context|input.*too.*long/i

function isRetryable(message: string): boolean {
  if (NON_RETRYABLE_PATTERN.test(message)) return false
  return RETRYABLE_PATTERN.test(message)
}

function isContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")) }, { once: true })
  })
}

// ---------------------------------------------------------------------------
// PendingMessageQueue
// Holds messages that are not yet injected into the agent loop.
// Supports two drain strategies (QueueMode):
//   "all"           - drain every queued message at once
//   "one-at-a-time" - drain only the oldest message per drain point
// ---------------------------------------------------------------------------
class PendingMessageQueue {
  private messages: Message[] = []
  public mode: QueueMode

  constructor(mode: QueueMode) {
    this.mode = mode
  }

  enqueue(message: Message): void {
    this.messages.push(message)
  }

  hasItems(): boolean {
    return this.messages.length > 0
  }

  /**
   * Drain messages according to the current QueueMode.
   * Returns the messages that should be injected now.
   */
  drain(): Message[] {
    if (this.mode === "all") {
      const drained = this.messages.slice()
      this.messages = []
      return drained
    }
    // "one-at-a-time"
    const first = this.messages[0]
    if (!first) return []
    this.messages = this.messages.slice(1)
    return [first]
  }

  clear(): void {
    this.messages = []
  }
}

// ---------------------------------------------------------------------------
// AgentHarness
// ---------------------------------------------------------------------------
export class AgentHarness {
  private running = false
  private abortController: AbortController | undefined
  private compactionAbortController: AbortController | undefined

  // Queues exposed via steer() / followUp()
  private readonly steerQueue: PendingMessageQueue
  private readonly followUpQueue: PendingMessageQueue

  // Auto-compaction
  private compactionSettings: CompactionSettings

  // Retry
  private retrySettings: RetrySettings

  /**
   * Cumulative token counters -- updated from turn_end usage events so that
   * shouldCompact() has accurate data for the threshold check.
   */
  private contextTokensAccumulated = 0
  private contextWindow = 0

  constructor(
    private readonly provider: Provider,
    private readonly config: AgentConfig,
    private readonly session: Session,
    options?: {
      /** How many steering messages to drain per drain point. Default: "one-at-a-time" */
      steeringMode?: QueueMode
      /** How many follow-up messages to drain per drain point. Default: "one-at-a-time" */
      followUpMode?: QueueMode
      /**
       * Auto-compaction settings.
       * Pass `{ enabled: false }` (merged with defaults) to disable.
       * Pass a full CompactionSettings object to fully control the behaviour.
       */
      compaction?: Partial<CompactionSettings>
      /**
       * The model's context window size (tokens).
       * Required for the threshold check.  If 0, auto-compaction is skipped.
       */
      contextWindow?: number
      /** Retry settings for transient API errors. */
      retry?: Partial<RetrySettings>
    },
  ) {
    this.steerQueue    = new PendingMessageQueue(options?.steeringMode ?? "one-at-a-time")
    this.followUpQueue = new PendingMessageQueue(options?.followUpMode ?? "one-at-a-time")
    this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options?.compaction }
    this.contextWindow = options?.contextWindow ?? 0
    this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options?.retry }
  }

  isRunning(): boolean { return this.running }

  /** Expose the underlying provider so callers can make direct API calls (e.g. for summary generation). */
  getProvider(): Provider { return this.provider }

  /** Expose the model name from the config. */
  getModel(): string { return this.config.model }

  // --------------------------------------------------------------------------
  // Queue control
  // --------------------------------------------------------------------------

  /**
   * Inject a message mid-run, after the current assistant turn finishes its
   * tool calls but before the next LLM call.
   *
   * Safe to call while the agent is running or idle.
   * When called while idle the message waits in the queue until the next prompt().
   */
  steer(text: string): void {
    this.steerQueue.enqueue(userMessage(text))
  }

  /**
   * Queue a follow-up message that will only be injected once the agent
   * would otherwise stop (no tool calls, no steering messages).
   *
   * This lets the caller queue a second task that starts automatically when
   * the first one finishes, without re-calling prompt().
   *
   * Safe to call while the agent is running or idle.
   */
  followUp(text: string): void {
    this.followUpQueue.enqueue(userMessage(text))
  }

  /** Remove all queued steering messages. */
  clearSteeringQueue(): void {
    this.steerQueue.clear()
  }

  /** Remove all queued follow-up messages. */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear()
  }

  /** Remove all queued steering AND follow-up messages. */
  clearAllQueues(): void {
    this.steerQueue.clear()
    this.followUpQueue.clear()
  }

  /** Returns true when either queue still has pending messages. */
  hasQueuedMessages(): boolean {
    return this.steerQueue.hasItems() || this.followUpQueue.hasItems()
  }

  /** Change how many steering messages are drained per drain point. */
  set steeringMode(mode: QueueMode) { this.steerQueue.mode = mode }
  get steeringMode(): QueueMode      { return this.steerQueue.mode }

  /** Change how many follow-up messages are drained per drain point. */
  set followUpMode(mode: QueueMode)  { this.followUpQueue.mode = mode }
  get followUpMode(): QueueMode      { return this.followUpQueue.mode }

  // --------------------------------------------------------------------------
  // Compaction settings / token tracking
  // --------------------------------------------------------------------------

  /**
   * Update the context window size used for the auto-compaction threshold check.
   * Call this whenever the model changes.
   */
  setContextWindow(tokens: number): void {
    this.contextWindow = tokens
  }

  /**
   * Update cumulative context-token count so the threshold check stays accurate.
   * Called by prompt() internally -- but you can also call it from the CLI after
   * each turn_end if you track usage externally.
   */
  updateContextTokens(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): void {
    this.contextTokensAccumulated = inputTokens + cacheReadTokens + cacheWriteTokens
  }

  /** Merge new settings into the current compaction config (partial update OK). */
  updateCompactionSettings(settings: Partial<CompactionSettings>): void {
    this.compactionSettings = { ...this.compactionSettings, ...settings }
  }

  // --------------------------------------------------------------------------
  // Abort
  // --------------------------------------------------------------------------

  /** Interrupt a running prompt. Safe to call even when idle. */
  abort(): void {
    this.abortController?.abort()
  }

  /**
   * Cancel an in-progress auto-compaction (user pressed Esc).
   * If no compaction is running this is a no-op.
   * Emits `compaction_end { aborted: true }` from the running prompt() generator.
   */
  abortCompaction(): void {
    this.compactionAbortController?.abort()
  }

  // --------------------------------------------------------------------------
  // prompt()
  // --------------------------------------------------------------------------

  async *prompt(userText: string): AsyncGenerator<AgentEvent> {
    if (this.running) {
      yield { type: "error", error: new AgentHarnessError("already_running", "Agent is already running") }
      yield { type: "agent_end", reason: "error" }
      return
    }
    this.running = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const msg = userMessage(userText)
    this.session.addMessage(msg)

    // Track the current assistant turn's parts (text + tool_calls).
    let assistantParts: MessagePart[] = []
    // Accumulate all tool results from the current turn so they can be saved
    // together as a single user message (the API requires this grouping).
    let pendingToolResults: MessagePart[] = []
    // Track in-progress tool_call_delta accumulation for building ToolCallParts.
    const pendingToolCalls = new Map<string, { name: string; inputJson: string }>()
    let hasPendingToolCalls = false
    // Track latest turn_end reason for auto-compaction check
    let agentEndReason: "done" | "max_turns" | "interrupted" | "error" = "done"
    // Track last error message for retry decisions
    let lastErrorMessage = ""

    // Save the accumulated assistant message + all tool results as a pair, then flush.
    // Must only be called once all tool_result events for the current turn have arrived.
    const flushToolTurn = async (): Promise<Error | undefined> => {
      if (!hasPendingToolCalls) return undefined
      this.session.addMessage(assistantMessage(assistantParts))
      if (pendingToolResults.length > 0) {
        this.session.addMessage({ role: "user", parts: pendingToolResults })
      }
      assistantParts = []
      pendingToolResults = []
      hasPendingToolCalls = false
      pendingToolCalls.clear()
      try { await this.session.flush(); return undefined }
      catch (e) { return e instanceof Error ? e : new Error(String(e)) }
    }

    // Build the loop config, wiring the queues to the callbacks the loop expects.
    const loopConfig: AgentConfig = {
      ...this.config,
      getSteeringMessages: async () => this.steerQueue.drain(),
      getFollowUpMessages: async () => this.followUpQueue.drain(),
    }

    let retryAttempt = 0
    const maxRetries = this.retrySettings.enabled ? this.retrySettings.maxRetries : 0
    const baseDelayMs = this.retrySettings.baseDelayMs

    try {
      retryLoop: while (true) {
      for await (const event of agentLoop(this.provider, this.session.messages(), loopConfig, signal)) {
        yield event

        if (event.type === "turn_start" && event.turnIndex > 0) {
          // All tool_result events for the previous turn have been yielded by the time
          // turn_start fires for the next turn -- safe to flush now.
          const flushErr = await flushToolTurn()
          if (flushErr) {
            yield { type: "error", error: new AgentHarnessError("session_write_failed", `Session flush failed: ${flushErr.message}`, flushErr) }
          }
        } else if (event.type === "text_delta") {
          const last = assistantParts[assistantParts.length - 1]
          if (last?.type === "text") last.text += event.delta
          else assistantParts.push({ type: "text", text: event.delta })
        } else if (event.type === "tool_call_start") {
          pendingToolCalls.set(event.id, { name: event.name, inputJson: "" })
        } else if (event.type === "tool_call_delta") {
          const call = pendingToolCalls.get(event.id)
          if (call) call.inputJson += event.delta
        } else if (event.type === "tool_call_end") {
          const call = pendingToolCalls.get(event.id)
          if (call) {
            let input: unknown = {}
            try { input = JSON.parse(call.inputJson) } catch { /* leave empty */ }
            assistantParts.push({ type: "tool_call", id: event.id, name: call.name, input } satisfies ToolCallPart)
            pendingToolCalls.delete(event.id)
            hasPendingToolCalls = true
          }
        } else if (event.type === "tool_result") {
          // Accumulate -- will be saved together with the assistant message on next turn_start / agent_end.
          pendingToolResults.push({ type: "tool_result", id: event.id, content: event.result, isError: event.isError })
        } else if (event.type === "turn_end") {
          // Update context-token tracking from real usage.
          // Mirror Pi's formula: input + output + cacheRead + cacheWrite.
          // Pi adds cacheRead/cacheWrite on top of input even though Anthropic includes
          // them in input_tokens -- the slight over-count means compaction fires a bit
          // earlier, which is the safer side.  Crucially we must include outputTokens
          // because the model's response becomes part of the next turn's context.
          if (event.usage) {
            this.contextTokensAccumulated =
              event.usage.inputTokens + event.usage.outputTokens +
              event.usage.cacheReadTokens + event.usage.cacheWriteTokens
          }
          if (!hasPendingToolCalls) {
            // Pure text turn -- save and flush immediately.
            if (assistantParts.length > 0) {
              this.session.addMessage(assistantMessage(assistantParts))
              assistantParts = []
            }
            try { await this.session.flush() } catch (e) {
              yield { type: "error", error: new AgentHarnessError("session_write_failed", `Session flush failed: ${e instanceof Error ? e.message : String(e)}`, e) }
            }
          }
          // If hasPendingToolCalls, defer flushing until next turn_start or agent_end
          // so all tool results are grouped into a single user message.
        } else if (event.type === "error") {
          lastErrorMessage = event.error.message
        } else if (event.type === "agent_end") {
          agentEndReason = event.reason
          // Flush any pending tool turn (covers the case where the last turn ended with tools).
          const flushErr = await flushToolTurn()
          if (flushErr) {
            yield { type: "error", error: new AgentHarnessError("session_write_failed", `Session flush failed: ${flushErr.message}`, flushErr) }
          }
          // Save any remaining assistant text (e.g. interrupted mid-stream).
          if (assistantParts.length > 0) {
            this.session.addMessage(assistantMessage(assistantParts))
            assistantParts = []
          }

          if (event.reason === "error" && !signal.aborted) {
            // Context-overflow path: compact first, then retry the same prompt
            if (isContextOverflow(lastErrorMessage) && this.compactionSettings.enabled && this.contextWindow > 0) {
              yield { type: "compaction_start", reason: "overflow", willRetry: true }
              this.compactionAbortController = new AbortController()
              const compactionSignal = this.compactionAbortController.signal
              const previousSummary = this.session.getPreviousSummary()
              try {
                const ABORTED = Symbol("aborted")
                const cancelPromise = new Promise<never>((_, reject) => {
                  if (compactionSignal.aborted) { reject(ABORTED); return }
                  compactionSignal.addEventListener("abort", () => reject(ABORTED), { once: true })
                })
                let result: Awaited<ReturnType<typeof compactMessages>>
                try {
                  result = await Promise.race([
                    compactMessages(this.session.messages(), this.provider, this.config.model, this.compactionSettings, previousSummary),
                    cancelPromise,
                  ])
                } catch (raceErr) {
                  if (raceErr === ABORTED) {
                    yield { type: "compaction_end", aborted: true }
                    break retryLoop
                  }
                  throw raceErr
                }
                const firstKeptEntryId = result.keptFromIndex > 0
                  ? this.session.entryIdAtMessageIndex(result.keptFromIndex)
                  : undefined
                await this.session.compact(result.summary, result.tokensBefore, firstKeptEntryId)
                this.contextTokensAccumulated = 0
                yield { type: "compaction_end", success: true, summary: result.summary, tokensBefore: result.tokensBefore, aborted: false, willRetry: true }
                // Reset and retry
                assistantParts = []
                pendingToolResults = []
                pendingToolCalls.clear()
                hasPendingToolCalls = false
                agentEndReason = "done"
                lastErrorMessage = ""
                continue retryLoop
              } catch (compactErr) {
                const error = compactErr instanceof Error ? compactErr : new Error(String(compactErr))
                yield { type: "compaction_end", success: false, error, aborted: false, willRetry: false }
              } finally {
                this.compactionAbortController = undefined
              }
            }
            // Transient error retry path
            else if (retryAttempt < maxRetries && isRetryable(lastErrorMessage)) {
              retryAttempt++
              const delayMs = baseDelayMs * Math.pow(2, retryAttempt - 1)
              yield { type: "retry_start", attempt: retryAttempt, maxAttempts: maxRetries, delayMs, errorMessage: lastErrorMessage }
              try { await sleep(delayMs, signal) } catch { break retryLoop }
              assistantParts = []
              pendingToolResults = []
              pendingToolCalls.clear()
              hasPendingToolCalls = false
              agentEndReason = "done"
              lastErrorMessage = ""
              yield { type: "retry_end", success: false, attempt: retryAttempt }
              continue retryLoop
            }
          }
        }
      }
      break retryLoop
      } // end retryLoop while(true)
    } finally {
      try { await this.session.flush() } catch { /* best-effort */ }
      this.running = false
      this.abortController = undefined
    }

    // ── Auto-compaction (Pi pattern) ─────────────────────────────────────────
    // Only fires when the agent completed normally (not interrupted / error).
    // Check threshold → emit compaction_start → compact → emit compaction_end.
    if (
      agentEndReason === "done" &&
      shouldCompact(this.contextTokensAccumulated, this.contextWindow, this.compactionSettings)
    ) {
      yield { type: "compaction_start", reason: "auto", willRetry: false }

      // Create a dedicated abort controller so the user can cancel compaction
      // via abortCompaction() without also aborting the main agent loop.
      this.compactionAbortController = new AbortController()
      const compactionSignal = this.compactionAbortController.signal

      // Read back the previous summary (if any) from the session for incremental update
      const previousSummary = this.session.getPreviousSummary()

      try {
        const messages = this.session.messages()

        // Run compactMessages in a race against the cancellation signal
        const resultPromise = compactMessages(
          messages,
          this.provider,
          this.config.model,
          this.compactionSettings,
          previousSummary,
        )

        // Wrap in a cancellation race: if the signal fires before the LLM
        // returns, reject with a sentinel so we emit aborted=true below.
        const ABORTED = Symbol("aborted")
        const cancelPromise = new Promise<never>((_, reject) => {
          if (compactionSignal.aborted) { reject(ABORTED); return }
          compactionSignal.addEventListener("abort", () => reject(ABORTED), { once: true })
        })

        let result: Awaited<typeof resultPromise>
        try {
          result = await Promise.race([resultPromise, cancelPromise])
        } catch (raceErr) {
          if (raceErr === ABORTED) {
            yield { type: "compaction_end", aborted: true }
            return
          }
          throw raceErr
        }

        // Map the cut-point message index back to a session entry ID so
        // session.messages() can reconstruct [summary + kept slice] (Pi pattern).
        const firstKeptEntryId = result.keptFromIndex > 0
          ? this.session.entryIdAtMessageIndex(result.keptFromIndex)
          : undefined

        await this.session.compact(result.summary, result.tokensBefore, firstKeptEntryId)

        // Reset accumulated token counter -- new context is much smaller
        this.contextTokensAccumulated = 0

        yield {
          type: "compaction_end",
          success: true,
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          aborted: false,
          willRetry: false,
        }
      } catch (compactErr) {
        const error = compactErr instanceof Error ? compactErr : new Error(String(compactErr))
        yield { type: "compaction_end", success: false, error, aborted: false, willRetry: false }
      } finally {
        this.compactionAbortController = undefined
      }
    }
  }

  // --------------------------------------------------------------------------
  // compact()
  // --------------------------------------------------------------------------

  async compact(summary: string, tokensBefore?: number): Promise<Result<void, AgentHarnessError>> {
    if (this.running) {
      return err(new AgentHarnessError("compact_while_running", "Cannot compact while agent is running"))
    }
    try {
      await this.session.compact(summary, tokensBefore)
      return ok(undefined)
    } catch (e) {
      return err(new AgentHarnessError("session_write_failed", `Compact failed: ${e instanceof Error ? e.message : String(e)}`, e))
    }
  }

  getSession(): Session { return this.session }
}
