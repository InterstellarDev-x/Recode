/**
 * Command palette modal — shown when the user types "/" in the input box.
 * Renders a compact list of matching commands with descriptions above the
 * input box.  Arrow keys navigate, Enter selects, Escape dismisses.
 */
import { T } from "../ansi.js"
import { visibleWidth } from "../ansi.js"

export interface PaletteCommand {
  name: string        // without leading "/"
  description: string
}

// All built-in slash commands (mirrors commands.ts)
export const PALETTE_COMMANDS: PaletteCommand[] = [
  { name: "help",     description: "Show all slash commands" },
  { name: "model",    description: "List / switch model" },
  { name: "provider", description: "List / switch provider" },
  { name: "session",  description: "Show current session info (tokens, cost)" },
  { name: "sessions", description: "List all sessions for this directory" },
  { name: "resume",   description: "Resume a previous session" },
  { name: "new",      description: "Start a fresh session" },
  { name: "name",     description: "Set a display name for this session" },
  { name: "export",   description: "Export conversation to file" },
  { name: "copy",     description: "Copy last assistant message to clipboard" },
  { name: "compact",  description: "AI-summarise context to save tokens" },
  { name: "clear",    description: "Clear chat display and reset context" },
  { name: "hotkeys",  description: "Show keyboard shortcuts" },
  { name: "quit",     description: "Exit recode" },
]

export interface CommandPaletteState {
  open: boolean
  selectedIndex: number
}

export function makePaletteState(): CommandPaletteState {
  return { open: false, selectedIndex: 0 }
}

/**
 * Given the current input value, returns the filtered command list and
 * whether the palette should be open.
 */
export function filteredCommands(inputValue: string): PaletteCommand[] {
  if (!inputValue.startsWith("/")) return []
  const query = inputValue.slice(1).toLowerCase()  // text after "/"
  if (!query) return PALETTE_COMMANDS               // show all when just "/"
  return PALETTE_COMMANDS.filter(
    (c) => c.name.startsWith(query) || c.description.toLowerCase().includes(query),
  )
}

/**
 * Render the command palette as a list of lines to be inserted just above
 * the input divider.  Returns [] when there's nothing to show.
 */
export function renderCommandPalette(
  inputValue: string,
  selectedIndex: number,
  width: number,
): string[] {
  const cmds = filteredCommands(inputValue)
  if (cmds.length === 0) return []

  const MAX_VISIBLE = 8
  const visible = cmds.slice(0, MAX_VISIBLE)

  // Header line
  const header =
    `${T.purpleMuted}╭${"─".repeat(width - 2)}╮${T.reset}`
  const footer =
    `${T.purpleMuted}╰${"─".repeat(width - 2)}╯${T.reset}`

  const lines: string[] = [header]

  visible.forEach((cmd, i) => {
    const isSelected = i === selectedIndex
    const slash    = `${T.purpleDim}/${T.reset}`
    const nameW    = 14
    const name     = `${T.white}${cmd.name.padEnd(nameW)}${T.reset}`
    const desc     = `${T.muted}${cmd.description}${T.reset}`

    const prefix = isSelected
      ? `${T.purpleMuted}│${T.reset} ${T.cursorBg}${T.white} ${T.reset} `
      : `${T.purpleMuted}│${T.reset}   `

    const row = `${prefix}${slash}${name} ${desc}`

    // Pad to full width so the border looks consistent
    const rawVisible = visibleWidth(row)
    const pad = Math.max(0, width - rawVisible - 1)
    lines.push(`${row}${" ".repeat(pad)}${T.purpleMuted}│${T.reset}`)
  })

  if (cmds.length > MAX_VISIBLE) {
    const more = `${T.dim}  … ${cmds.length - MAX_VISIBLE} more (keep typing to filter)${T.reset}`
    const rawVisible = visibleWidth(more)
    const pad = Math.max(0, width - rawVisible - 1)
    lines.push(
      `${T.purpleMuted}│${T.reset}${more}${" ".repeat(pad)}${T.purpleMuted}│${T.reset}`,
    )
  }

  lines.push(footer)

  // Navigation hint
  lines.push(
    `${T.dim}  ↑↓ navigate  Enter select  Esc dismiss${T.reset}`,
  )

  return lines
}
