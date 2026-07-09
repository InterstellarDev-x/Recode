import { T } from "../ansi.js"

export interface PendingMessage {
  text: string
  mode: "steer" | "followUp"
}

/**
 * Renders a Pi-style "pending messages" panel shown above the input box
 * while the agent is running or compacting.
 *
 * Layout (zero lines when queue is empty):
 *
 *   Steering: fix the auth bug
 *   Follow-up: then run the tests
 *   ↳ Alt+↑ to edit queued messages
 */
export function renderPendingMessages(pending: PendingMessage[], width: number): string[] {
  if (pending.length === 0) return []

  const lines: string[] = []

  for (const msg of pending) {
    const label = msg.mode === "steer" ? "Steering" : "Follow-up"
    const raw   = `  ${label}: ${msg.text}`
    // Truncate to terminal width (strip to fit, re-apply reset)
    const truncated = raw.length > width - 1 ? raw.slice(0, width - 4) + "…" : raw
    lines.push(`${T.dim}${truncated}${T.reset}`)
  }

  lines.push(`${T.dim}  ↳ Alt+↑ to edit queued messages${T.reset}`)

  return lines
}
