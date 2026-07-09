import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"

export type KeyEvent =
  | { type: "char"; char: string }
  | { type: "enter" } | { type: "backspace" } | { type: "delete" }
  | { type: "left" } | { type: "right" } | { type: "home" } | { type: "end" }
  | { type: "up" } | { type: "down" }
  | { type: "page_up" } | { type: "page_down" }
  | { type: "scroll_up" } | { type: "scroll_down" }
  | { type: "ctrl_c" } | { type: "ctrl_d" } | { type: "ctrl_l" } | { type: "ctrl_u" } | { type: "ctrl_w" }
  | { type: "tab" } | { type: "escape" } | { type: "unknown"; raw: string }
  // #8 -- bracketed paste delivers the full pasted string at once
  | { type: "paste"; text: string }
  // Alt+T: toggle compaction summary expand/collapse (⌥T on macOS, Alt+T on Windows)
  | { type: "alt_t" }
  // Alt+Enter: queue as follow-up (fires after agent would otherwise stop)
  | { type: "alt_enter" }
  // Alt+↑: dequeue all pending steer/followUp messages back into the editor
  | { type: "alt_up" }

// Bracketed paste markers
const PASTE_START = "\x1b[200~"
const PASTE_END   = "\x1b[201~"

export function parseKey(data: Buffer): KeyEvent {
  const s = data.toString()
  const b = data[0]

  // #8 -- Bracketed paste: \x1b[200~ ... content ... \x1b[201~
  // May arrive in a single chunk or across multiple reads; handle single-chunk case here.
  if (s.includes(PASTE_START)) {
    const startIdx = s.indexOf(PASTE_START)
    const endIdx   = s.indexOf(PASTE_END)
    if (endIdx !== -1) {
      // Complete paste in one chunk
      const pasted = s.slice(startIdx + PASTE_START.length, endIdx)
      return { type: "paste", text: pasted }
    }
    // Incomplete paste -- treat as unknown and let InputState handle buffering
    return { type: "unknown", raw: s }
  }

  if (s === "\r" || s === "\n") return { type: "enter" }
  if (s === "\x7f" || s === "\x08") return { type: "backspace" }
  if (s === "\x03") return { type: "ctrl_c" }
  if (s === "\x04") return { type: "ctrl_d" }
  if (s === "\x0c") return { type: "ctrl_l" }
  if (s === "\x15") return { type: "ctrl_u" }
  if (s === "\x17") return { type: "ctrl_w" }
  if (s === "\t") return { type: "tab" }
  if (s === "\x1b") return { type: "escape" }
  // Alt+T: \x1bt (standard xterm/VTE/macOS), or CSI u form \x1b[84;3u (Windows Terminal kitty protocol)
  if (s === "\x1bt" || s === "\x1b[84;3u") return { type: "alt_t" }
  // Alt+Enter: \x1b\r or \x1b\n (most terminals), or CSI u form \x1b[13;3u
  if (s === "\x1b\r" || s === "\x1b\n" || s === "\x1b[13;3u") return { type: "alt_enter" }
  // Alt+↑: \x1b[1;3A (xterm modifyOtherKeys / VTE), or \x1b[A with meta bit
  if (s === "\x1b[1;3A" || s === "\x1b\x1b[A") return { type: "alt_up" }
  if (s === "\x1b[A") return { type: "up" }
  if (s === "\x1b[B") return { type: "down" }
  if (s === "\x1b[C") return { type: "right" }
  if (s === "\x1b[D") return { type: "left" }
  if (s === "\x1b[H" || s === "\x1b[1~") return { type: "home" }
  if (s === "\x1b[F" || s === "\x1b[4~") return { type: "end" }
  if (s === "\x1b[3~") return { type: "delete" }
  if (s === "\x1b[5~") return { type: "page_up" }
  if (s === "\x1b[6~") return { type: "page_down" }
  // Mouse scroll wheel (SGR and X10 protocols)
  if (s === "\x1b[M`" || s === "\x1b[<64;1;1M" || s.startsWith("\x1b[64;")) return { type: "scroll_up" }
  if (s === "\x1b[Ma" || s === "\x1b[<65;1;1M" || s.startsWith("\x1b[65;")) return { type: "scroll_down" }
  if (b !== undefined && b >= 0x20 && !s.startsWith("\x1b")) return { type: "char", char: s }
  return { type: "unknown", raw: s }
}

const MAX_HISTORY = 500

export class InputState {
  value = ""; cursor = 0
  history: string[] = []; historyIndex = -1
  private historyFile: string | undefined

  // #8 -- Bracketed paste buffering (for split-chunk pastes)
  private _pasteBuffer = ""
  private _isPasting   = false

  /** Load history from disk (call once at startup) */
  async loadHistory(historyFile: string): Promise<void> {
    this.historyFile = historyFile
    if (!existsSync(historyFile)) return
    try {
      const text = await readFile(historyFile, "utf-8")
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
      // Keep newest at the end (ready for historyUp traversal)
      this.history = lines.slice(-MAX_HISTORY)
    } catch { /* ignore */ }
  }

  /** Persist history to disk (call on submit) */
  private async saveHistory(): Promise<void> {
    if (!this.historyFile) return
    try {
      await mkdir(dirname(this.historyFile), { recursive: true })
      await writeFile(this.historyFile, this.history.join("\n") + "\n", "utf-8")
    } catch { /* best-effort */ }
  }

  setValue(text: string): void { this.value = text; this.cursor = text.length }
  insert(char: string): void { this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor); this.cursor += char.length }

  /** #8 -- Insert a multi-character string (used for paste). Newlines become spaces. */
  insertText(text: string): void {
    // Replace newlines with spaces so a multi-line paste becomes one input line
    const sanitized = text.replace(/\r\n|\r|\n/g, " ")
    this.value  = this.value.slice(0, this.cursor) + sanitized + this.value.slice(this.cursor)
    this.cursor += sanitized.length
  }

  /**
   * #8 -- Feed a raw data chunk for bracketed-paste buffering.
   * Call this when the data contains \x1b[200~ but no closing \x1b[201~ yet.
   * Returns true when the paste is complete (closing marker received).
   */
  feedPasteChunk(raw: string): boolean {
    const PASTE_START = "\x1b[200~"
    const PASTE_END   = "\x1b[201~"

    if (!this._isPasting) {
      const startIdx = raw.indexOf(PASTE_START)
      if (startIdx === -1) return false
      this._isPasting   = true
      this._pasteBuffer = raw.slice(startIdx + PASTE_START.length)
    } else {
      this._pasteBuffer += raw
    }

    const endIdx = this._pasteBuffer.indexOf(PASTE_END)
    if (endIdx !== -1) {
      const pasted = this._pasteBuffer.slice(0, endIdx)
      this._pasteBuffer = ""
      this._isPasting   = false
      this.insertText(pasted)
      return true
    }
    return false
  }

  backspace(): void { if (this.cursor === 0) return; this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor); this.cursor-- }
  deleteForward(): void { if (this.cursor >= this.value.length) return; this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1) }
  moveLeft(): void { if (this.cursor > 0) this.cursor-- }
  moveRight(): void { if (this.cursor < this.value.length) this.cursor++ }
  moveHome(): void { this.cursor = 0 }
  moveEnd(): void { this.cursor = this.value.length }
  clearLine(): void { this.value = ""; this.cursor = 0 }
  deleteWord(): void {
    let i = this.cursor
    while (i > 0 && this.value[i - 1] === " ") i--
    while (i > 0 && this.value[i - 1] !== " ") i--
    this.value = this.value.slice(0, i) + this.value.slice(this.cursor)
    this.cursor = i
  }
  historyUp(): void {
    if (!this.history.length) return
    if (this.historyIndex === -1) this.historyIndex = this.history.length - 1
    else if (this.historyIndex > 0) this.historyIndex--
    const e = this.history[this.historyIndex]; if (e !== undefined) { this.value = e; this.cursor = e.length }
  }
  historyDown(): void {
    if (this.historyIndex === -1) return
    this.historyIndex++
    if (this.historyIndex >= this.history.length) { this.historyIndex = -1; this.value = ""; this.cursor = 0 }
    else { const e = this.history[this.historyIndex]; if (e !== undefined) { this.value = e; this.cursor = e.length } }
  }
  submit(): string {
    const text = this.value.trim()
    if (text) {
      // Avoid consecutive duplicates
      if (this.history[this.history.length - 1] !== text) {
        this.history.push(text)
        if (this.history.length > MAX_HISTORY) this.history.shift()
      }
      // Fire-and-forget persist
      this.saveHistory().catch(() => { /* ignore */ })
    }
    this.value = ""; this.cursor = 0; this.historyIndex = -1
    return text
  }
}
