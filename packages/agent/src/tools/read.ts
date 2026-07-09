import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const readTool: AgentTool = {
  definition: {
    name: "read",
    description: "Read the contents of a file. Supports optional line offset and limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        offset: { type: "number", description: "Start line (1-indexed, optional)" },
        limit: { type: "number", description: "Max lines to read (optional)" },
      },
      required: ["path"],
    },
  },

  async execute(input: unknown): Promise<string> {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number }
    const absPath = resolve(path)
    if (!existsSync(absPath)) return `Error: file not found: ${absPath}`

    const buf = await readFile(absPath)
    if (buf.byteLength > 200_000 && offset === undefined && limit === undefined) {
      return buf.subarray(0, 200_000).toString("utf-8") + `\n<truncated: ${buf.byteLength} bytes>`
    }

    const text = buf.toString("utf-8")
    if (offset !== undefined || limit !== undefined) {
      const lines = text.split("\n")
      const start = Math.max(0, (offset ?? 1) - 1)
      const end = limit !== undefined ? start + limit : lines.length
      return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n")
    }
    return text
  },
}
