import { readdir } from "node:fs/promises"
import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AgentTool } from "../types.js"

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export const lsTool: AgentTool = {
  definition: {
    name: "ls",
    description: "List files and directories at a given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (defaults to cwd)" },
      },
      required: [],
    },
  },
  async execute(input: unknown): Promise<string> {
    const { path } = (input ?? {}) as { path?: string }
    const absPath = resolve(path ?? process.cwd())
    if (!existsSync(absPath)) return `Error: path not found: ${absPath}`
    const stat = statSync(absPath)
    if (!stat.isDirectory()) return `Error: not a directory: ${absPath}`
    const entries = await readdir(absPath, { withFileTypes: true })
    const lines = entries.map((e) => {
      const isDir = e.isDirectory()
      const size = !isDir ? fmt(statSync(join(absPath, e.name)).size) : ""
      return `${e.name}${isDir ? "/" : ""}${size ? `  ${size}` : ""}`
    })
    return `${absPath}\n${lines.join("\n") || "(empty)"}`
  },
}
