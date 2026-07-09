import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const writeTool: AgentTool = {
  definition: {
    name: "write",
    description: "Write content to a file, creating parent directories as needed. Overwrites existing files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  async execute(input: unknown): Promise<string> {
    const { path, content } = input as { path: string; content: string }
    const absPath = resolve(path)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, content, "utf-8")
    return `Written: ${absPath}`
  },
}
