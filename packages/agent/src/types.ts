import type { Message, ToolDefinition, Usage } from "@recode/ai"

// ---------------------------------------------------------------------------
// Result<T,E> -- Pi-style typed return values (no throw for known error paths)
// ---------------------------------------------------------------------------
export type Result<TValue, TError> =
  | { ok: true;  value: TValue }
  | { ok: false; error: TError }

export function ok<TValue, TError = never>(value: TValue): Result<TValue, TError> {
  return { ok: true, value }
}

export function err<TError, TValue = never>(error: TError): Result<TValue, TError> {
  return { ok: false, error }
}

export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (result.ok) return result.value
  throw result.error
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------
export type AgentHarnessErrorCode =
  | "already_running"
  | "session_write_failed"
  | "compact_while_running"
  | "unknown"

export class AgentHarnessError extends Error {
  readonly code: AgentHarnessErrorCode
  readonly originalCause?: unknown
  constructor(code: AgentHarnessErrorCode, message: string, originalCause?: unknown) {
    super(message)
    this.name = "AgentHarnessError"
    this.code = code
    this.originalCause = originalCause
  }
}

export type ToolValidationErrorCode = "missing_required" | "wrong_type" | "schema_mismatch"

export class ToolValidationError extends Error {
  readonly code: ToolValidationErrorCode
  readonly toolName: string
  constructor(toolName: string, code: ToolValidationErrorCode, message: string) {
    super(message)
    this.name = "ToolValidationError"
    this.code = code
    this.toolName = toolName
  }
}

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------
export interface AgentTool {
  definition: ToolDefinition
  /** Override per-tool; defaults to config.toolExecution */
  executionMode?: "sequential" | "parallel"
  execute(input: unknown): Promise<string>
}

// ---------------------------------------------------------------------------
// Hook types (Pi-style)
// ---------------------------------------------------------------------------
export interface BeforeToolCallResult {
  /** Set to true to block the tool call and return a synthetic error result */
  block?: boolean
  reason?: string
}

export interface AfterToolCallResult {
  /** Override the tool result content */
  overrideContent?: string
  /** Force isError flag */
  isError?: boolean
  /** Terminate the agent loop after this tool result */
  terminate?: boolean
}

export interface BeforeToolCallContext {
  toolName: string
  toolInput: unknown
  callId: string
  turnIndex: number
}

export interface AfterToolCallContext {
  toolName: string
  toolInput: unknown
  callId: string
  result: string
  isError: boolean
  turnIndex: number
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "turn_end"; usage?: Usage }
  | { type: "agent_end"; reason: "done" | "max_turns" | "interrupted" | "error" }
  | { type: "error"; error: AgentHarnessError | ToolValidationError | Error }
  /**
   * Fired by AgentHarness when auto-compaction starts.
   * The consumer should queue user inputs rather than drop them.
   *
   * - reason "manual":    triggered by the user via /compact
   * - reason "auto":      triggered automatically when the token threshold is exceeded
   * - reason "overflow":  triggered when the LLM returns a context-too-long error;
   *                       willRetry=true means the failed prompt will be retried after
   *                       compaction completes.
   */
  | { type: "compaction_start"; reason: "manual" | "auto" | "overflow"; willRetry: boolean }
  /**
   * Fired when auto-compaction finishes.
   *
   * - success=true:  summary + tokensBefore are populated; consumer should
   *   rebuild the chat view and inject a compaction summary card.
   *   willRetry=true means the harness will automatically re-run the last prompt
   *   after this event (overflow recovery) — the consumer should flush queued
   *   messages via steer/followUp rather than prompt().
   * - success=false: error is populated; consumer should show an error.
   * - aborted=true:  user cancelled via Esc — no changes were made.
   */
  | {
      type: "compaction_end"
      success: true
      summary: string
      tokensBefore: number
      aborted: false
      /** True when the harness will re-run the last prompt after compaction (overflow recovery). */
      willRetry: boolean
    }
  | {
      type: "compaction_end"
      success: false
      error: Error
      aborted: false
      willRetry: boolean
    }
  | {
      type: "compaction_end"
      aborted: true
    }
  | { type: "retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "retry_end"; success: boolean; attempt: number }

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------
export type ToolExecutionMode = "sequential" | "parallel"

/**
 * Controls how many queued messages are drained when the loop reaches a drain point.
 *
 * - "all":            drain and inject every queued message at once.
 * - "one-at-a-time":  drain and inject only the oldest message, leaving the rest for the next drain point.
 */
export type QueueMode = "all" | "one-at-a-time"

export interface AgentConfig {
  provider: string
  model: string
  system?: string
  tools: AgentTool[]
  maxTurns?: number
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  maxRetryDelayMs?: number
  /** Default tool execution mode; per-tool override via AgentTool.executionMode */
  toolExecution?: ToolExecutionMode
  /** Called before each tool; return { block: true } to prevent execution */
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>
  /** Called after each tool; can override result or terminate loop */
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>

  /**
   * Returns steering messages to inject mid-run, after each assistant turn finishes
   * executing its tool calls (but before the next LLM call starts).
   *
   * Useful for injecting user corrections while the agent is still working.
   * Contract: must not throw. Return [] when nothing is queued.
   */
  getSteeringMessages?: () => Promise<Message[]>

  /**
   * Returns follow-up messages to process after the agent would otherwise stop.
   *
   * Called only when the agent has no more tool calls AND no steering messages.
   * If messages are returned the agent restarts with them as the new prompt.
   *
   * Useful for queuing a second request that should wait until the agent is fully done.
   * Contract: must not throw. Return [] when nothing is queued.
   */
  getFollowUpMessages?: () => Promise<Message[]>
}
