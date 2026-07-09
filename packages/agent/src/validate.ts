import type { ToolDefinition } from "@recode/ai"
import { ToolValidationError } from "./types.js"

interface AgentToolLike {
  definition: ToolDefinition
}

/**
 * Validates tool arguments against the tool's inputSchema (plain JSON Schema).
 * Checks required fields are present and does basic type coercion (string→number).
 * Throws ToolValidationError on hard failures.
 * Returns the (possibly coerced) args on success.
 */
export function validateToolInput(tool: AgentToolLike, args: unknown): unknown {
  const schema = tool.definition.inputSchema
  const input = (args != null && typeof args === "object" && !Array.isArray(args))
    ? { ...(args as Record<string, unknown>) }
    : {}

  const required: string[] = schema.required ?? []
  const properties = schema.properties ?? {}

  // Check required fields
  for (const key of required) {
    if (!(key in input) || input[key] === undefined || input[key] === null) {
      throw new ToolValidationError(
        tool.definition.name,
        "missing_required",
        `Tool "${tool.definition.name}" missing required parameter: "${key}"`,
      )
    }
  }

  // Coerce types where safe (e.g. model returns a number as a string)
  for (const [key, propSchema] of Object.entries(properties)) {
    const val = input[key]
    if (val === undefined) continue
    const prop = propSchema as Record<string, unknown>
    if (prop["type"] === "number" || prop["type"] === "integer") {
      if (typeof val === "string" && val.trim() !== "" && !isNaN(Number(val))) {
        input[key] = Number(val)
      }
    } else if (prop["type"] === "boolean") {
      if (val === "true") input[key] = true
      else if (val === "false") input[key] = false
    }
  }

  return input
}
