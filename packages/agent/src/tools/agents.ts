/**
 * Agent definition discovery and parsing.
 *
 * Agents are Markdown files with YAML-like frontmatter stored in:
 *   ~/.recode/agents/*.md      (user-global)
 *   <project>/.recode/agents/*.md  (project-local, walks up from cwd)
 *
 * Frontmatter format:
 * ---
 * name: reviewer
 * description: Reviews code for correctness and style
 * tools: read,grep,find
 * model: claude-sonnet-4-5
 * ---
 * System prompt body…
 */

import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AgentDefinition {
  /** Unique name used to invoke this agent (e.g. "reviewer") */
  name: string
  /** Short description shown in tool description / agent discovery */
  description: string
  /** Comma-separated list of tool names available to this agent. Defaults to all DEFAULT_TOOLS. */
  tools?: string
  /** Model override. Falls back to the parent agent's model if omitted. */
  model?: string
  /** The raw system prompt (frontmatter-stripped body) */
  systemPrompt: string
  /** Where the file was loaded from (for debugging) */
  source: string
}

// ---------------------------------------------------------------------------
// Frontmatter parser  (no external deps -- pure string parsing)
// ---------------------------------------------------------------------------
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  const trimmed = raw.trimStart()

  if (!trimmed.startsWith("---")) {
    return { meta, body: raw }
  }

  const afterOpen = trimmed.slice(3)
  const closeIdx  = afterOpen.indexOf("\n---")

  if (closeIdx === -1) {
    return { meta, body: raw }
  }

  const frontmatter = afterOpen.slice(0, closeIdx)
  const body        = afterOpen.slice(closeIdx + 4).trimStart() // skip "\n---"

  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key   = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) meta[key] = value
  }

  return { meta, body }
}

// ---------------------------------------------------------------------------
// Load a single .md file as an AgentDefinition
// ---------------------------------------------------------------------------
export async function loadAgentFile(filePath: string): Promise<AgentDefinition | null> {
  try {
    const raw = await readFile(filePath, "utf-8")
    const { meta, body } = parseFrontmatter(raw)

    const name = meta["name"]?.trim()
    if (!name) return null  // name is mandatory

    const tools = meta["tools"]?.trim()
    const model = meta["model"]?.trim()
    return {
      name,
      description: meta["description"]?.trim() ?? `Sub-agent: ${name}`,
      ...(tools !== undefined ? { tools } : {}),
      ...(model !== undefined ? { model } : {}),
      systemPrompt: body,
      source: filePath,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Scan a directory for *.md files and return parsed agent definitions
// ---------------------------------------------------------------------------
async function loadAgentsFromDir(dir: string): Promise<AgentDefinition[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    const defs: AgentDefinition[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const def = await loadAgentFile(join(dir, entry))
      if (def) defs.push(def)
    }
    return defs
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Walk up from `startDir` to find the nearest `.recode/agents/` directory.
// Returns the first one found, or null if none exists within the fs root.
// ---------------------------------------------------------------------------
function findProjectAgentsDir(startDir: string): string | null {
  let current = startDir
  while (true) {
    const candidate = join(current, ".recode", "agents")
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null  // reached fs root
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Public API: load all agents visible from `cwd`
//   1. User-global:    ~/.recode/agents/
//   2. Project-local:  <nearest .recode>/agents/
// Project-local definitions shadow user-global ones with the same name.
// ---------------------------------------------------------------------------
export async function loadAllAgents(cwd: string = process.cwd()): Promise<AgentDefinition[]> {
  const globalDir  = join(homedir(), ".recode", "agents")
  const projectDir = findProjectAgentsDir(cwd)

  const globalAgents  = await loadAgentsFromDir(globalDir)
  const projectAgents = projectDir ? await loadAgentsFromDir(projectDir) : []

  // Merge: project-local agents shadow global ones with the same name
  const byName = new Map<string, AgentDefinition>()
  for (const def of globalAgents)  byName.set(def.name, def)
  for (const def of projectAgents) byName.set(def.name, def)  // override

  return [...byName.values()]
}

// ---------------------------------------------------------------------------
// Look up a single agent by name from the visible set
// ---------------------------------------------------------------------------
export async function findAgent(name: string, cwd: string = process.cwd()): Promise<AgentDefinition | null> {
  const all = await loadAllAgents(cwd)
  return all.find((a) => a.name === name) ?? null
}
