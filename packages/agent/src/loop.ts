import type { Provider } from "@recode/ai"
import { assistantMessage, userMessage, type Message, type MessagePart, type ToolCallPart } from "@recode/ai"
import type { AgentConfig, AgentEvent, AgentTool } from "./types.js"
import { validateToolInput } from "./validate.js"

export async function* agentLoop(
  provider: Provider,
  messages: Message[],
  config: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map<string, AgentTool>(config.tools.map((t) => [t.definition.name, t]))

  yield { type: "agent_start" }

  const history = [...messages]
  const maxTurns = config.maxTurns ?? 50
  let turnIndex = 0

  // Poll the steering queue once at the very start so messages typed while the
  // previous agent run was settling are picked up before the first LLM call.
  let pendingSteering: Message[] = (await config.getSteeringMessages?.()) ?? []

  // ---------------------------------------------------------------------------
  // Outer loop: re-enters when follow-up messages arrive after the agent stops
  // ---------------------------------------------------------------------------
  while (true) {
    let hasMoreToolCalls = true

    // -------------------------------------------------------------------------
    // Inner loop: processes one assistant turn (+ steering injections) at a time
    // -------------------------------------------------------------------------
    while (hasMoreToolCalls || pendingSteering.length > 0) {
      // Check for abort before each turn
      if (signal?.aborted) {
        yield { type: "agent_end", reason: "interrupted" }
        return
      }

      if (turnIndex >= maxTurns) {
        yield { type: "agent_end", reason: "max_turns" }
        return
      }

      // Inject steering messages that arrived since the last turn
      if (pendingSteering.length > 0) {
        for (const msg of pendingSteering) {
          history.push(msg)
        }
        pendingSteering = []
      }

      yield { type: "turn_start", turnIndex }

      const assistantParts: MessagePart[] = []
      const pending = new Map<string, { name: string; inputJson: string }>()
      let hasToolCalls = false

      const stream = provider.stream({
        model: config.model,
        ...(config.system !== undefined ? { system: config.system } : {}),
        messages: history,
        tools: config.tools.map((t) => t.definition),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
        ...(config.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: config.maxRetryDelayMs } : {}),
      })

      for await (const event of stream) {
        // Respect abort signal mid-stream
        if (signal?.aborted) {
          yield { type: "agent_end", reason: "interrupted" }
          return
        }

        if (event.type === "text_delta") {
          yield event
          const last = assistantParts[assistantParts.length - 1]
          if (last?.type === "text") last.text += event.delta
          else assistantParts.push({ type: "text", text: event.delta })
        } else if (event.type === "thinking_delta") {
          yield event
          // accumulate into a thinking part (not sent back to the model)
        } else if (event.type === "tool_call_start") {
          hasToolCalls = true
          pending.set(event.id, { name: event.name, inputJson: "" })
          yield event
        } else if (event.type === "tool_call_delta") {
          const call = pending.get(event.id)
          if (call) call.inputJson += event.delta
          yield event
        } else if (event.type === "tool_call_end") {
          // Forward the event AND finalise the tool call part
          yield event
          const call = pending.get(event.id)
          if (call) {
            let input: unknown = {}
            try { input = JSON.parse(call.inputJson) } catch { /* leave empty */ }
            assistantParts.push({ type: "tool_call", id: event.id, name: call.name, input } satisfies ToolCallPart)
          }
        } else if (event.type === "done") {
          yield event.usage !== undefined ? { type: "turn_end", usage: event.usage } : { type: "turn_end" }
        } else if (event.type === "error") {
          yield { type: "error", error: event.error }
          yield { type: "agent_end", reason: "error" }
          return
        }
      }

      history.push(assistantMessage(assistantParts))
      turnIndex++

      if (!hasToolCalls) {
        // No tool calls this turn — agent would stop after inner loop exits.
        hasMoreToolCalls = false
        // Poll for steering messages that arrived during the LLM response.
        pendingSteering = (await config.getSteeringMessages?.()) ?? []
        continue
      }

      // -----------------------------------------------------------------------
      // Execute tool calls
      // -----------------------------------------------------------------------
      const toolCallParts = assistantParts.filter((p): p is ToolCallPart => p.type === "tool_call")

      // Determine execution mode for this batch:
      // Use parallel if config says parallel AND no tool in this batch forces sequential
      const globalMode = config.toolExecution ?? "sequential"
      const anySequential = toolCallParts.some((p) => {
        const tool = toolMap.get(p.name)
        return tool?.executionMode === "sequential"
      })
      const runParallel = globalMode === "parallel" && !anySequential

      let interrupted = false
      let resultParts: MessagePart[]

      if (runParallel) {
        // Collect events locally — no module-level shared buffer
        const collectedEvents: AgentEvent[] = []
        const { parts, terminate } = await executeParallel(
          toolCallParts,
          toolMap,
          config,
          turnIndex - 1,
          (e) => collectedEvents.push(e),
        )
        resultParts = parts
        for (const e of collectedEvents) yield e
        if (terminate) interrupted = true
      } else {
        resultParts = []
        for (const part of toolCallParts) {
          if (signal?.aborted) { interrupted = true; break }
          const { resultPart, event, terminate } = await executeSingle(part, toolMap, config, turnIndex - 1)
          yield event
          resultParts.push(resultPart)
          if (terminate) { interrupted = true; break }
        }
      }

      history.push({ role: "user", parts: resultParts })

      if (interrupted) {
        yield { type: "agent_end", reason: "interrupted" }
        return
      }

      hasMoreToolCalls = true
      // Poll for steering messages typed while tools were executing
      pendingSteering = (await config.getSteeringMessages?.()) ?? []
    }
    // ---- end inner loop ----

    // The agent has no tool calls and no steering messages — it would stop here.
    // Check the follow-up queue: if something is queued, inject it and re-enter.
    const followUps: Message[] = (await config.getFollowUpMessages?.()) ?? []
    if (followUps.length > 0) {
      for (const msg of followUps) {
        history.push(msg)
      }
      // Reset so the inner loop starts a fresh turn with the follow-up message
      pendingSteering = []
      hasMoreToolCalls = true  // ensure inner loop enters at least once
      // Re-seed pendingSteering at the top of the next outer iteration
      continue
    }

    // Nothing left — genuine stop.
    break
  }
  // ---- end outer loop ----

  yield { type: "agent_end", reason: "done" }
}

// ---------------------------------------------------------------------------
// Single tool execution (with hooks + validation)
// ---------------------------------------------------------------------------
async function executeSingle(
  part: ToolCallPart,
  toolMap: Map<string, AgentTool>,
  config: AgentConfig,
  turnIndex: number,
): Promise<{ resultPart: MessagePart; event: AgentEvent; terminate: boolean }> {
  const tool = toolMap.get(part.name)
  let result: string
  let isError = false
  let terminate = false

  if (!tool) {
    result = `Error: unknown tool "${part.name}"`
    isError = true
  } else {
    // beforeToolCall hook
    if (config.beforeToolCall) {
      try {
        const hookResult = await config.beforeToolCall({ toolName: part.name, toolInput: part.input, callId: part.id, turnIndex })
        if (hookResult?.block) {
          result = `Tool call blocked: ${hookResult.reason ?? "blocked by beforeToolCall hook"}`
          isError = true
          return {
            resultPart: { type: "tool_result", id: part.id, content: result, isError },
            event: { type: "tool_result", id: part.id, name: part.name, result, isError },
            terminate: false,
          }
        }
      } catch (hookErr) {
        result = `beforeToolCall hook error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`
        isError = true
        return {
          resultPart: { type: "tool_result", id: part.id, content: result, isError },
          event: { type: "tool_result", id: part.id, name: part.name, result, isError },
          terminate: false,
        }
      }
    }

    // Validate input
    let validatedInput = part.input
    try {
      validatedInput = validateToolInput(tool, part.input)
    } catch (validationErr) {
      result = validationErr instanceof Error ? validationErr.message : String(validationErr)
      isError = true
      return {
        resultPart: { type: "tool_result", id: part.id, content: result, isError },
        event: { type: "tool_result", id: part.id, name: part.name, result, isError },
        terminate: false,
      }
    }

    // Execute
    try {
      result = await tool.execute(validatedInput)
    } catch (execErr) {
      result = `Error: ${execErr instanceof Error ? execErr.message : String(execErr)}`
      isError = true
    }

    // afterToolCall hook
    if (config.afterToolCall) {
      try {
        const hookResult = await config.afterToolCall({ toolName: part.name, toolInput: validatedInput, callId: part.id, result, isError, turnIndex })
        if (hookResult) {
          if (hookResult.overrideContent !== undefined) result = hookResult.overrideContent
          if (hookResult.isError !== undefined) isError = hookResult.isError
          if (hookResult.terminate) terminate = true
        }
      } catch { /* ignore hook errors in afterToolCall */ }
    }
  }

  return {
    resultPart: { type: "tool_result", id: part.id, content: result, isError },
    event: { type: "tool_result", id: part.id, name: part.name, result, isError },
    terminate,
  }
}

// ---------------------------------------------------------------------------
// Parallel execution: run all tool calls concurrently via Promise.all
// Results are emitted in original assistant order (not completion order)
// terminate=true only when ALL tools in the batch request termination
// ---------------------------------------------------------------------------
async function executeParallel(
  parts: ToolCallPart[],
  toolMap: Map<string, AgentTool>,
  config: AgentConfig,
  turnIndex: number,
  emitEvent: (e: AgentEvent) => void,
): Promise<{ parts: MessagePart[]; terminate: boolean }> {
  const results = await Promise.all(
    parts.map((part) => executeSingle(part, toolMap, config, turnIndex)),
  )

  const resultParts: MessagePart[] = []
  let allTerminate = results.length > 0
  for (const { resultPart, event, terminate } of results) {
    emitEvent(event)
    resultParts.push(resultPart)
    if (!terminate) allTerminate = false
  }
  return { parts: resultParts, terminate: allTerminate }
}
