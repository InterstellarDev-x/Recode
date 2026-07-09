import { readdir, readFile } from "node:fs/promises"
import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AgentTool } from "../types.js"

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build"])

async function* walkFiles(dir: string, glob?: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walkFiles(full, glob)
    else if (!glob || matchGlob(e.name, glob)) yield full
  }
}

function matchGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1))
  return name === pattern
}

export const grepTool: AgentTool = {
  definition: {
    name: "grep",
    description: "Search for a regex pattern in files. Returns file:line: content matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search (defaults to cwd)" },
        glob: { type: "string", description: "File name filter e.g. '*.ts'" },
        case_insensitive: { type: "boolean", description: "Case-insensitive search" },
      },
      required: ["pattern"],
    },
  },
  async execute(input: unknown): Promise<string> {
    const { pattern, path, glob, case_insensitive } = input as { pattern: string; path?: string; glob?: string; case_insensitive?: boolean }
    const searchPath = resolve(path ?? process.cwd())
    let regex: RegExp
    try { regex = new RegExp(pattern, case_insensitive ? "i" : undefined) }
    catch { return `Error: invalid regex: ${pattern}` }

    const stat = existsSync(searchPath) ? statSync(searchPath) : null
    if (!stat) return `Error: path not found: ${searchPath}`

    const results: string[] = []
    const files = stat.isFile() ? [searchPath] : walkFiles(searchPath, glob)

    for await (const file of files) {
      if (results.length >= 100) break
      let text: string
      try { text = await readFile(file, "utf-8") } catch { continue }
      text.split("\n").forEach((line, i) => {
        if (results.length < 100 && regex.test(line)) results.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }

    if (results.length === 0) return "No matches found"
    return results.join("\n") + (results.length >= 100 ? "\n(truncated at 100 results)" : "")
  },
}
