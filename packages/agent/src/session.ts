import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { userMessage, type Message } from "@recode/ai"

/**
 * Repair history that may have been written by an earlier buggy version of the harness.
 *
 * Invariant the API requires:
 *   Every tool_result part in a user message must have a matching tool_call part
 *   with the same id in the immediately preceding assistant message.
 *
 * Strategy:
 *   1. Collect tool_call ids declared by each assistant message.
 *   2. For each user message that contains tool_result parts, drop any part
 *      whose id has no matching tool_call in the previous assistant message.
 *   3. Drop any assistant message whose only content is tool_call parts that
 *      have no corresponding results (avoids dangling tool_use blocks).
 *   4. Remove user messages that become empty after stripping.
 */
function sanitizeHistory(msgs: Message[]): Message[] {
  const out: Message[] = []

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!

    if (msg.role === "user") {
      const toolResultParts = msg.parts.filter((p) => p.type === "tool_result")
      const otherParts      = msg.parts.filter((p) => p.type !== "tool_result")

      if (toolResultParts.length === 0) {
        out.push(msg)
        continue
      }

      // Collect all tool_call ids declared by the preceding assistant message.
      const prev = out[out.length - 1]
      const declaredIds = new Set<string>()
      if (prev?.role === "assistant") {
        for (const p of prev.parts) {
          if (p.type === "tool_call") declaredIds.add(p.id)
        }
      }

      const validResults = toolResultParts.filter((p) => p.type === "tool_result" && declaredIds.has(p.id))

      if (validResults.length === 0 && otherParts.length === 0) continue // drop the whole message

      out.push({ role: "user", parts: [...otherParts, ...validResults] })
      continue
    }

    if (msg.role === "assistant") {
      const toolCallParts = msg.parts.filter((p) => p.type === "tool_call")
      const otherParts    = msg.parts.filter((p) => p.type !== "tool_call")

      if (toolCallParts.length === 0) {
        out.push(msg)
        continue
      }

      // Look ahead: find which tool_call ids have results in the next user message.
      const nextMsg = msgs[i + 1]
      const resultIds = new Set<string>()
      if (nextMsg?.role === "user") {
        for (const p of nextMsg.parts) {
          if (p.type === "tool_result") resultIds.add(p.id)
        }
      }

      const validCalls = toolCallParts.filter((p) => p.type === "tool_call" && resultIds.has(p.id))

      if (validCalls.length === 0 && otherParts.length === 0) continue // drop orphan assistant tool-call message

      out.push({ role: "assistant", parts: [...otherParts, ...validCalls] })
      continue
    }

    out.push(msg)
  }

  return out
}

export interface SessionEntry {
  id: string
  timestamp: number
  type: "user" | "assistant" | "compaction"
  message?: Message
  summary?: string
  /** Total tokens consumed before this compaction (input + output). Used for display. */
  tokensBefore?: number
  /**
   * ID of the first entry retained verbatim after compaction.
   * Entries from this ID onward are appended after the summary message when
   * rebuilding the context sent to the API (Pi pattern).
   * Absent on old compaction entries → fall back to summary-only behaviour.
   */
  firstKeptEntryId?: string
}

export interface SessionMeta {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  name?: string
  /** Cumulative cost in USD across all turns (persisted so it survives resume) */
  totalCostUsd?: number
  /** Cumulative input tokens (persisted) */
  totalInputTokens?: number
  /** Cumulative output tokens (persisted) */
  totalOutputTokens?: number
  /** Cumulative cache-read tokens (persisted) */
  totalCacheReadTokens?: number
  /** Cumulative cache-write tokens (persisted) */
  totalCacheWriteTokens?: number
}

// Encode a cwd path into a safe directory name (same technique as Pi)
function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

export class Session {
  private entries: SessionEntry[] = []
  private pendingBuffer: SessionEntry[] = []
  private _meta: SessionMeta

  private constructor(
    readonly id: string,
    private readonly filePath: string,
    private readonly metaPath: string,
    meta: SessionMeta,
  ) {
    this._meta = meta
  }

  // ─── Static factory: load existing ──────────────────────────────────────────

  static async load(sessionsDir: string, sessionId: string): Promise<Session> {
    const filePath = join(sessionsDir, `${sessionId}.jsonl`)
    const metaPath  = join(sessionsDir, `${sessionId}.meta.json`)

    let meta: SessionMeta = { id: sessionId, cwd: process.cwd(), createdAt: Date.now(), updatedAt: Date.now() }
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(await readFile(metaPath, "utf-8")) as SessionMeta } catch { /* keep default */ }
    }

    const session = new Session(sessionId, filePath, metaPath, meta)
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, "utf-8")
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { session.entries.push(JSON.parse(trimmed) as SessionEntry) } catch { /* skip corrupt */ }
      }
    }
    return session
  }

  // ─── Static factory: ephemeral (no disk I/O) ────────────────────────────────
  /**
   * Creates an in-memory-only session -- nothing is ever written to disk.
   * Used by sub-agents invoked via `recode --json --no-session`.
   */
  static async createEphemeral(): Promise<Session> {
    const sessionId = crypto.randomUUID()
    const meta: SessionMeta = {
      id: sessionId,
      cwd: process.cwd(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // Pass empty strings for file paths; flush() is overridden to no-op below.
    const session = new Session(sessionId, "", "", meta)
    // Override flush and compact to be no-ops so nothing touches the filesystem.
    session.flush   = async () => { /* ephemeral -- no disk writes */ }
    session.compact = async () => { /* ephemeral -- no disk writes */ }
    return session
  }

  // ─── Static factory: create new ─────────────────────────────────────────────

  static async create(sessionsDir: string, sessionId: string, name?: string): Promise<Session> {
    // Scope sessions under a cwd-specific subdirectory (Pi pattern)
    const cwdDir = join(sessionsDir, encodeCwd(process.cwd()))
    await mkdir(cwdDir, { recursive: true })

    const filePath = join(cwdDir, `${sessionId}.jsonl`)
    const metaPath  = join(cwdDir, `${sessionId}.meta.json`)

    const meta: SessionMeta = {
      id: sessionId,
      cwd: process.cwd(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(name !== undefined ? { name } : {}),
    }

    // Write metadata immediately so we can find this session later
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8")

    return new Session(sessionId, filePath, metaPath, meta)
  }

  // ─── Auto-resume: find the most recent session for current cwd ─────────────

  /**
   * Returns the most-recently-updated session ID for the current working
   * directory, or undefined if none exist yet.  Mirrors the Pi pattern of
   * scoping sessions per directory.
   */
  static async findLastForCwd(sessionsDir: string): Promise<string | undefined> {
    const cwdDir = join(sessionsDir, encodeCwd(process.cwd()))
    if (!existsSync(cwdDir)) return undefined
    try {
      const files = await readdir(cwdDir)
      const metas = files.filter((f) => f.endsWith(".meta.json"))
      if (metas.length === 0) return undefined

      const parsed: SessionMeta[] = []
      for (const f of metas) {
        try {
          const raw = await readFile(join(cwdDir, f), "utf-8")
          parsed.push(JSON.parse(raw) as SessionMeta)
        } catch { /* skip */ }
      }

      parsed.sort((a, b) => b.updatedAt - a.updatedAt)
      return parsed[0]?.id
    } catch {
      return undefined
    }
  }

  // ─── Load from cwd-scoped dir ────────────────────────────────────────────────

  static async loadFromCwd(sessionsDir: string, sessionId: string): Promise<Session> {
    const cwdDir    = join(sessionsDir, encodeCwd(process.cwd()))
    const filePath  = join(cwdDir, `${sessionId}.jsonl`)
    const metaPath  = join(cwdDir, `${sessionId}.meta.json`)

    let meta: SessionMeta = { id: sessionId, cwd: process.cwd(), createdAt: Date.now(), updatedAt: Date.now() }
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(await readFile(metaPath, "utf-8")) as SessionMeta } catch { /* keep default */ }
    }

    const session = new Session(sessionId, filePath, metaPath, meta)
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, "utf-8")
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { session.entries.push(JSON.parse(trimmed) as SessionEntry) } catch { /* skip corrupt */ }
      }
    }
    return session
  }

  // ─── List session IDs for any dir ────────────────────────────────────────────

  static async listIds(sessionsDir: string): Promise<string[]> {
    if (!existsSync(sessionsDir)) return []
    const allIds: string[] = []

    try {
      const cwdDirs = await readdir(sessionsDir)
      for (const dir of cwdDirs) {
        const dirPath = join(sessionsDir, dir)
        try {
          const files = await readdir(dirPath)
          for (const f of files) {
            if (f.endsWith(".meta.json")) {
              try {
                const raw = await readFile(join(dirPath, f), "utf-8")
                const meta = JSON.parse(raw) as SessionMeta
                allIds.push(meta.id)
              } catch { /* skip */ }
            }
          }
        } catch { /* skip non-dirs */ }
      }
    } catch { /* ignore */ }

    // Also scan old flat layout for backwards compat
    try {
      const files = await readdir(sessionsDir)
      for (const f of files) {
        if (f.endsWith(".jsonl")) allIds.push(f.replace(/\.jsonl$/, ""))
      }
    } catch { /* ignore */ }

    return [...new Set(allIds)]
  }

  // ─── List sessions for current cwd with metadata ─────────────────────────────

  static async listForCwd(sessionsDir: string): Promise<SessionMeta[]> {
    const cwdDir = join(sessionsDir, encodeCwd(process.cwd()))
    if (!existsSync(cwdDir)) return []
    const metas: SessionMeta[] = []
    try {
      const files = await readdir(cwdDir)
      for (const f of files.filter((f) => f.endsWith(".meta.json"))) {
        try {
          const raw = await readFile(join(cwdDir, f), "utf-8")
          metas.push(JSON.parse(raw) as SessionMeta)
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  // ─── Instance API ─────────────────────────────────────────────────────────────

  get meta(): SessionMeta { return { ...this._meta } }

  messages(): Message[] {
    const raw: Message[] = []

    // Find the last compaction entry (if any) and rebuild context the Pi way:
    // [summary message] + [entries from firstKeptEntryId onward] + [post-compaction entries]
    let lastCompactionIdx = -1
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.type === "compaction") { lastCompactionIdx = i; break }
    }

    if (lastCompactionIdx === -1) {
      // No compaction — use all entries
      for (const entry of this.entries) {
        if (entry.message) raw.push(entry.message)
      }
    } else {
      const compaction = this.entries[lastCompactionIdx]!
      raw.push(userMessage(`<previous_context>\n${compaction.summary}\n</previous_context>`))

      if (compaction.firstKeptEntryId) {
        // Find the kept slice that was interleaved before the compaction entry
        let keepFrom = -1
        for (let i = 0; i < lastCompactionIdx; i++) {
          if (this.entries[i]!.id === compaction.firstKeptEntryId) { keepFrom = i; break }
        }
        if (keepFrom !== -1) {
          for (let i = keepFrom; i < lastCompactionIdx; i++) {
            const e = this.entries[i]!
            if (e.message) raw.push(e.message)
          }
        }
      }
      // Always include all entries written after the compaction entry itself
      for (let i = lastCompactionIdx + 1; i < this.entries.length; i++) {
        const e = this.entries[i]!
        if (e.message) raw.push(e.message)
      }
    }

    return sanitizeHistory(raw)
  }

  addMessage(message: Message): void {
    const entry: SessionEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: message.role === "user" ? "user" : "assistant",
      message,
    }
    this.entries.push(entry)
    this.pendingBuffer.push(entry)
  }

  async flush(): Promise<void> {
    if (this.pendingBuffer.length === 0) return
    const lines = this.pendingBuffer.map((e) => JSON.stringify(e)).join("\n") + "\n"
    this.pendingBuffer = []
    await appendFile(this.filePath, lines, "utf-8")

    // Update updatedAt in metadata
    this._meta.updatedAt = Date.now()
    try { await writeFile(this.metaPath, JSON.stringify(this._meta, null, 2), "utf-8") } catch { /* best-effort */ }
  }

  async compact(summary: string, tokensBefore?: number, firstKeptEntryId?: string): Promise<void> {
    const entry: SessionEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: "compaction",
      summary,
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(firstKeptEntryId !== undefined ? { firstKeptEntryId } : {}),
    }
    // Keep all existing entries on disk so the kept slice can still be read back.
    // Append the compaction entry; messages() will reconstruct the right view.
    this.entries.push(entry)
    this.pendingBuffer = [entry]
    await mkdir(dirname(this.filePath), { recursive: true })
    await this.flush()

    this._meta.updatedAt = Date.now()
    try { await writeFile(this.metaPath, JSON.stringify(this._meta, null, 2), "utf-8") } catch { /* best-effort */ }
  }

  /**
   * Persist cumulative token/cost stats into session metadata so they survive
   * resume. Called after each turn from main.ts.
   */
  async updateCumulativeStats(stats: {
    totalCostUsd: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
  }): Promise<void> {
    this._meta.totalCostUsd          = stats.totalCostUsd
    this._meta.totalInputTokens      = stats.totalInputTokens
    this._meta.totalOutputTokens     = stats.totalOutputTokens
    this._meta.totalCacheReadTokens  = stats.totalCacheReadTokens
    this._meta.totalCacheWriteTokens = stats.totalCacheWriteTokens
    this._meta.updatedAt = Date.now()
    try { await writeFile(this.metaPath, JSON.stringify(this._meta, null, 2), "utf-8") } catch { /* best-effort */ }
  }

  async setName(name: string): Promise<void> {
    this._meta.name = name
    this._meta.updatedAt = Date.now()
    try { await writeFile(this.metaPath, JSON.stringify(this._meta, null, 2), "utf-8") } catch { /* best-effort */ }
  }

  entryCount(): number { return this.entries.length }

  /**
   * Map a 0-based index in the message array (as returned by messages()) back
   * to the session entry ID of that message.  Used by the harness to compute
   * `firstKeptEntryId` after compaction determines a cut point.
   *
   * Skips compaction entries (they produce synthetic messages) and returns the
   * ID of the Nth actual message entry.  Returns undefined if out of range.
   */
  entryIdAtMessageIndex(index: number): string | undefined {
    // Build the same ordered list of (entryId | undefined) that messages() produces,
    // with undefined for the synthetic compaction summary message.
    const ids: Array<string | undefined> = []

    let lastCompactionIdx = -1
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.type === "compaction") { lastCompactionIdx = i; break }
    }

    if (lastCompactionIdx === -1) {
      for (const entry of this.entries) {
        if (entry.message) ids.push(entry.id)
      }
    } else {
      ids.push(undefined)  // synthetic summary message has no entry ID

      const compaction = this.entries[lastCompactionIdx]!
      if (compaction.firstKeptEntryId) {
        let keepFrom = -1
        for (let i = 0; i < lastCompactionIdx; i++) {
          if (this.entries[i]!.id === compaction.firstKeptEntryId) { keepFrom = i; break }
        }
        if (keepFrom !== -1) {
          for (let i = keepFrom; i < lastCompactionIdx; i++) {
            const e = this.entries[i]!
            if (e.message) ids.push(e.id)
          }
        }
      }
      for (let i = lastCompactionIdx + 1; i < this.entries.length; i++) {
        const e = this.entries[i]!
        if (e.message) ids.push(e.id)
      }
    }

    return ids[index]
  }

  /**
   * Returns the summary text from the most recent compaction entry, if any.
   * Used by AgentHarness to pass `previousSummary` for incremental compaction.
   */
  getPreviousSummary(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!
      if (entry.type === "compaction" && entry.summary) {
        return entry.summary
      }
    }
    return undefined
  }
}
