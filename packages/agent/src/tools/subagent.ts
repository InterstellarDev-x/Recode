/**
 * subagent tool -- spawn a child `recode --json` process and capture its output.
 *
 * Three invocation modes:
 *
 *  Single:
 *    { agent: "name", task: "Do X", cwd?: "..." }
 *
 *  Parallel (up to MAX_PARALLEL tasks concurrently):
 *    { tasks: [{ agent, task, cwd? }, ...] }
 *
 *  Chain (sequential, each task receives previous output as {previous}):
 *    { chain: [{ agent, task, cwd? }, ...] }
 */

import { spawn } from "node:child_process"
import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { AgentTool } from "../types.js"
import { findAgent } from "./agents.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_OUTPUT_BYTES = 50 * 1024          // 50 KB per sub-task
const MAX_PARALLEL     = 8
const CONCURRENCY      = 4
const KILL_TIMEOUT_MS  = 5_000             // grace period before SIGKILL

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------
interface SubTask {
  agent: string
  task: string
  cwd?: string
}

type SubAgentInput =
  | { agent: string; task: string; cwd?: string }
  | { tasks: SubTask[] }
  | { chain: SubTask[] }

// ---------------------------------------------------------------------------
// Helper: resolve the `recode` binary path
// We find the current process's argv[0] (bun) and re-use it to run
// the cli entry point directly, which is the most reliable approach.
// ---------------------------------------------------------------------------
function resolveRecodeArgs(): { cmd: string; baseArgs: string[] } {
  // When running via `bun packages/cli/src/main.ts` or installed as `recode`,
  // process.argv[1] is the path to main.ts / the recode bin.
  const entryPoint = process.argv[1] ?? "recode"
  return {
    cmd:      process.execPath,   // bun (or node)
    baseArgs: [entryPoint],
  }
}

// ---------------------------------------------------------------------------
// Helper: write a temp file and return its path
// ---------------------------------------------------------------------------
async function writeTempFile(content: string): Promise<string> {
  const path = join(tmpdir(), `recode-agent-${randomUUID()}.md`)
  await writeFile(path, content, "utf-8")
  return path
}

// ---------------------------------------------------------------------------
// Core: run a single sub-agent task
// Returns the captured text output (stdout JSONL text_delta events joined)
// ---------------------------------------------------------------------------
async function runSubTask(
  task: SubTask,
  previousOutput: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  // Resolve agent definition
  const agentDef = await findAgent(task.agent, task.cwd ?? process.cwd())
  if (!agentDef) {
    return `<error>Agent "${task.agent}" not found. Create ~/.recode/agents/${task.agent}.md or .recode/agents/${task.agent}.md</error>`
  }

  // Interpolate {previous} placeholder for chain mode
  const resolvedTask = previousOutput !== undefined
    ? task.task.replace(/\{previous\}/g, previousOutput)
    : task.task

  // Build extra args
  const extraArgs: string[] = []

  if (agentDef.model) {
    extraArgs.push("--model", agentDef.model)
  }

  if (agentDef.tools) {
    extraArgs.push("--tools", agentDef.tools)
  }

  // Write system prompt to a temp file
  let systemPromptFile: string | undefined
  if (agentDef.systemPrompt.trim()) {
    systemPromptFile = await writeTempFile(agentDef.systemPrompt)
    extraArgs.push("--append-system-prompt", systemPromptFile)
  }

  const { cmd, baseArgs } = resolveRecodeArgs()
  const spawnArgs = [...baseArgs, "--json", "--no-session", ...extraArgs, resolvedTask]

  return new Promise<string>((resolve) => {
    let outputBytes  = 0
    let textOutput   = ""
    let truncated    = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const child = spawn(cmd, spawnArgs, {
      cwd:   task.cwd ?? process.cwd(),
      env:   process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    // Propagate abort signal → SIGTERM, then SIGKILL after grace period
    const onAbort = () => {
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL") } catch { /* already dead */ }
      }, KILL_TIMEOUT_MS)
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    function cleanup() {
      signal?.removeEventListener("abort", onAbort)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (systemPromptFile) {
        unlink(systemPromptFile).catch(() => { /* best-effort */ })
        systemPromptFile = undefined
      }
    }

    // Parse JSONL from stdout -- collect text_delta events
    let lineBuffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return
      lineBuffer += chunk.toString("utf-8")
      const lines = lineBuffer.split("\n")
      lineBuffer = lines.pop() ?? ""  // last partial line stays in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>
          if (event["type"] === "text_delta" && typeof event["delta"] === "string") {
            const delta = event["delta"] as string
            const bytes = Buffer.byteLength(delta, "utf-8")
            if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
              textOutput += delta.slice(0, MAX_OUTPUT_BYTES - outputBytes)
              truncated = true
              outputBytes = MAX_OUTPUT_BYTES
              break
            }
            textOutput += delta
            outputBytes += bytes
          }
        } catch { /* non-JSON line -- ignore */ }
      }
    })

    // Collect stderr for error reporting
    let stderrText = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf-8")
    })

    child.on("close", (code) => {
      cleanup()
      if (signal?.aborted) {
        resolve(`<interrupted>Sub-agent task was interrupted.</interrupted>`)
        return
      }
      if (truncated) {
        textOutput += `\n<truncated>Output exceeded ${MAX_OUTPUT_BYTES / 1024}KB limit.</truncated>`
      }
      if (!textOutput.trim() && code !== 0) {
        const errMsg = stderrText.trim() || `exit code ${code}`
        resolve(`<error>Sub-agent "${task.agent}" failed: ${errMsg}</error>`)
        return
      }
      resolve(textOutput.trim() || "(no output)")
    })

    child.on("error", (spawnErr) => {
      cleanup()
      resolve(`<error>Failed to spawn sub-agent: ${spawnErr.message}</error>`)
    })
  })
}

// ---------------------------------------------------------------------------
// Pool helper: run tasks with bounded concurrency
// ---------------------------------------------------------------------------
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<string>,
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = new Array(items.length).fill("")
  const queue = items.map((item, i) => ({ item, i }))
  let qi = 0

  async function worker() {
    while (qi < queue.length) {
      if (signal?.aborted) break
      const { item, i } = queue[qi++]!
      results[i] = await fn(item, i)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------
export const subagentTool: AgentTool = {
  definition: {
    name: "subagent",
    description: `Delegate tasks to specialised sub-agents defined in ~/.recode/agents/ or .recode/agents/.

Three modes:
  Single:   { "agent": "name", "task": "Do X" }
  Parallel: { "tasks": [{ "agent": "name", "task": "Do X" }, ...] }  -- up to ${MAX_PARALLEL} tasks, run ${CONCURRENCY} at a time
  Chain:    { "chain": [{ "agent": "name", "task": "Do X" }, ...] }  -- sequential; use {previous} in task to reference prior output

Each agent is defined by a .md file with YAML frontmatter (name, description, tools, model) and a system prompt body.`,
    inputSchema: {
      type: "object",
      properties: {
        // ── Single mode ──────────────────────────────────────────────────────
        agent: {
          type: "string",
          description: "Name of the agent to invoke (single mode)",
        },
        task: {
          type: "string",
          description: "Task description / prompt for the agent (single mode)",
        },
        cwd: {
          type: "string",
          description: "Working directory override (optional, any mode)",
        },
        // ── Parallel mode ────────────────────────────────────────────────────
        tasks: {
          type: "array",
          description: `Parallel mode: array of up to ${MAX_PARALLEL} tasks run ${CONCURRENCY} at a time`,
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent name" },
              task:  { type: "string", description: "Task prompt" },
              cwd:   { type: "string", description: "Working directory (optional)" },
            },
            required: ["agent", "task"],
          },
        },
        // ── Chain mode ───────────────────────────────────────────────────────
        chain: {
          type: "array",
          description: "Chain mode: sequential tasks where {previous} is replaced by the prior step output",
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent name" },
              task:  { type: "string", description: "Task prompt; use {previous} for prior output" },
              cwd:   { type: "string", description: "Working directory (optional)" },
            },
            required: ["agent", "task"],
          },
        },
      },
      // No top-level `required` -- the LLM picks the right combination
    },
  },

  // Sub-agents are I/O-bound, safe to run in parallel
  executionMode: "parallel",

  async execute(input: unknown): Promise<string> {
    const parsed = input as SubAgentInput

    // ── Single mode ──────────────────────────────────────────────────────────
    if ("agent" in parsed && "task" in parsed) {
      const singleTask: SubTask = parsed.cwd !== undefined
        ? { agent: parsed.agent, task: parsed.task, cwd: parsed.cwd }
        : { agent: parsed.agent, task: parsed.task }
      const result = await runSubTask(singleTask, undefined)
      return result
    }

    // ── Parallel mode ────────────────────────────────────────────────────────
    if ("tasks" in parsed) {
      const tasks = parsed.tasks.slice(0, MAX_PARALLEL)
      const results = await runWithConcurrency(
        tasks,
        CONCURRENCY,
        (t) => runSubTask(t, undefined),
      )
      return results
        .map((r, i) => `<task index="${i}" agent="${tasks[i]!.agent}">\n${r}\n</task>`)
        .join("\n\n")
    }

    // ── Chain mode ───────────────────────────────────────────────────────────
    if ("chain" in parsed) {
      const steps   = parsed.chain
      const outputs: string[] = []
      let previous: string | undefined

      for (let i = 0; i < steps.length; i++) {
        const step   = steps[i]!
        const result = await runSubTask(step, previous)
        outputs.push(result)
        previous = result
      }

      return outputs
        .map((r, i) => `<step index="${i}" agent="${steps[i]!.agent}">\n${r}\n</step>`)
        .join("\n\n")
    }

    return `<error>Invalid subagent input: expected { agent, task }, { tasks: [...] }, or { chain: [...] }</error>`
  },
}
