import { T } from "../ansi.js"

export interface InputBoxProps {
  value: string
  cursorPos: number
  isRunning: boolean
  width: number
  placeholder?: string
  /** Number of pending steer/followUp messages currently queued */
  pendingCount?: number
}

export function renderInputBox(p: InputBoxProps): string[] {
  const divider = `${T.purpleMuted}${"─".repeat(p.width)}${T.reset}`
  const prompt = p.isRunning
    ? `${T.green}⠿ ${T.reset}`
    : `${T.purple}❯ ${T.reset}`
  const display = !p.value && p.placeholder
    ? `${T.dim}${p.placeholder}${T.reset}`
    : insertCursor(p.value, p.cursorPos)
  let hint: string
  if (p.isRunning) {
    const queueHint = (p.pendingCount ?? 0) > 0
      ? `  ·  ${T.reset}${T.dim}Alt+↑ to edit queued`
      : `  ·  Alt+Enter to follow-up`
    hint = `${T.dim}  Enter ↵ to steer${queueHint}  ·  Ctrl+C to interrupt${T.reset}`
  } else {
    hint = `${T.dim}  Enter ↵  /help  /quit${T.reset}`
  }
  return [divider, prompt + display, hint]
}

function insertCursor(text: string, pos: number): string {
  const ch = text[pos] ?? " "
  return `${T.white}${text.slice(0, pos)}${T.reset}` +
    `${T.cursorBg}${T.white}${ch}${T.reset}` +
    `${T.white}${text.slice(pos + 1)}${T.reset}`
}
