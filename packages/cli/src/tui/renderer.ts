import { cursor, screen } from "./ansi.js"

const MIN_FRAME_MS = 16 // ~60fps cap

export class Renderer {
  private prevLines: string[] = []
  private width: number
  private height: number
  private pendingLines: string[] | undefined
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private lastFrameAt = 0

  constructor() {
    this.width = process.stdout.columns ?? 80
    this.height = process.stdout.rows ?? 24
    process.stdout.on("resize", () => {
      this.width = process.stdout.columns ?? 80
      this.height = process.stdout.rows ?? 24
      this.prevLines = []
      if (this.pendingLines) this.flush()
    })
  }

  get cols(): number { return this.width }
  get rows(): number { return this.height }

  // Called on every state change — coalesces into one write per frame
  render(lines: string[]): void {
    this.pendingLines = lines
    if (this.frameTimer) return // already scheduled
    const elapsed = performance.now() - this.lastFrameAt
    const delay = Math.max(0, MIN_FRAME_MS - elapsed)
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined
      if (this.pendingLines) this.flush()
    }, delay)
  }

  // Force an immediate write (used by shutdown, enterAlt, etc.)
  flushNow(lines?: string[]): void {
    if (lines) this.pendingLines = lines
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = undefined }
    this.flush()
  }

  private flush(): void {
    const lines = this.pendingLines
    this.pendingLines = undefined
    if (!lines) return
    this.lastFrameAt = performance.now()

    const out: string[] = []
    const visible = lines.slice(0, this.height)

    for (let i = 0; i < this.height; i++) {
      const newLine = visible[i] ?? ""
      if (newLine === (this.prevLines[i] ?? null)) continue
      out.push(cursor.to(i + 1, 1), screen.clearLine, newLine)
    }

    this.prevLines = [...visible]
    if (out.length > 0) process.stdout.write(out.join(""))
  }

  invalidate(): void { this.prevLines = []; if (this.pendingLines) this.flush() }
  clear(): void { process.stdout.write(screen.clear); this.prevLines = [] }
  enterAlt(): void { process.stdout.write(screen.alternateOn + cursor.hide); this.prevLines = [] }
  exitAlt(): void {
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = undefined }
    process.stdout.write(screen.alternateOff + cursor.show)
  }
}
