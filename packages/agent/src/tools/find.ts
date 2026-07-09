import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AgentTool } from "../types.js"

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build"])

async function* walk(dir: string, regex: RegExp, maxDepth: number, depth = 0): AsyncGenerator<string> {
  if (depth > maxDepth) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    const full = join(dir, e.name)
    if (regex.test(e.name)) yield full
    if (e.isDirectory()) yield* walk(full, regex, maxDepth, depth + 1)
  }
}

export const findTool: AgentTool = {
  definition: {
    name: "find",
    description: "Find files or directories by name pattern (glob or exact).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "File name pattern (e.g. '*.ts' or 'package.json')" },
        path: { type: "string", description: "Directory to search (defaults to cwd)" },
        max_depth: { type: "number", description: "Max directory depth (default 10)" },
      },
      required: ["pattern"],
    },
  },
  async execute(input: unknown): Promise<string> {
    const { pattern, path, max_depth } = input as { pattern: string; path?: string; max_depth?: number }
    const searchPath = resolve(path ?? process.cwd())
    if (!existsSync(searchPath)) return `Error: path not found: ${searchPath}`

    const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
    const regex = new RegExp(`^${regexStr}$`, "i")

    const results: string[] = []
    for await (const file of walk(searchPath, regex, max_depth ?? 10)) {
      results.push(file)
      if (results.length >= 200) break
    }

    if (results.length === 0) return "No files found"
    return results.join("\n") + (results.length >= 200 ? "\n(truncated at 200 results)" : "")
  },
}
