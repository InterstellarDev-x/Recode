import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

function normalise(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/'/g, "'").replace(/'/g, "'").replace(/"/g, '"').replace(/"/g, '"').replace(/—/g, "--").replace(/–/g, "-")
}

export const editTool: AgentTool = {
  definition: {
    name: "edit",
    description: "Replace an exact string in a file with new content. old_string must appear exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        old_string: { type: "string", description: "Exact text to find (must be unique in the file)" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async execute(input: unknown): Promise<string> {
    const { path, old_string, new_string } = input as { path: string; old_string: string; new_string: string }
    const absPath = resolve(path)
    if (!existsSync(absPath)) return `Error: file not found: ${absPath}`

    const raw = await readFile(absPath, "utf-8")
    const normed = normalise(raw)
    const normOld = normalise(old_string)
    const count = normed.split(normOld).length - 1

    if (count === 0) return `Error: old_string not found. Check whitespace and indentation match exactly.`
    if (count > 1) return `Error: old_string appears ${count} times. Provide more context to make it unique.`

    await writeFile(absPath, normed.replace(normOld, new_string), "utf-8")
    return `Edited: ${absPath}`
  },
}
