import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { relative, resolve, sep } from "node:path"
import { T, padEnd, truncate, visibleWidth } from "../ansi.js"

export interface StatusBarProps {
  provider: string; model: string; sessionId: string
  isRunning: boolean
  isAutoCompacting?: boolean  // true while auto-compaction is running
  inputTokens: number; outputTokens: number
  cacheReadTokens: number; cacheWriteTokens: number
  totalCostUsd: number
  contextWindow: number       // model's max context window (0 = unknown)
  width: number
  scrollOffset?: number
  cwd?: string                // current working directory (for footer line)
}

// ---------------------------------------------------------------------------
// #1 -- Smart token formatter (Pi-style)
// ---------------------------------------------------------------------------
export function formatTokens(n: number): string {
  if (n < 1_000)        return n.toString()
  if (n < 10_000)       return `${(n / 1_000).toFixed(1)}k`
  if (n < 1_000_000)    return `${Math.round(n / 1_000)}k`
  if (n < 10_000_000)   return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1_000_000)}M`
}

// ---------------------------------------------------------------------------
// #3 -- Smart cost formatter
// ---------------------------------------------------------------------------
function formatCost(usd: number): string {
  if (usd < 0.01)  return `$${usd.toFixed(4)}`
  if (usd < 1.00)  return `$${usd.toFixed(3)}`
  if (usd < 10.0)  return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(1)}`
}

// ---------------------------------------------------------------------------
// #4 -- CWD formatter: replace home dir with ~  (Pi pattern)
// ---------------------------------------------------------------------------
export function formatCwd(cwd: string): string {
  const home = homedir()
  const resolvedCwd  = resolve(cwd)
  const resolvedHome = resolve(home)
  const rel = relative(resolvedHome, resolvedCwd)
  // rel starts with ".." means cwd is outside home -- show full path
  const isInsideHome = rel !== ".." && !rel.startsWith(`..${sep}`) && rel !== ""
  if (!isInsideHome) return resolvedCwd
  return rel === "" ? "~" : `~${sep}${rel}`
}

// ---------------------------------------------------------------------------
// #4 -- Git branch (sync read of HEAD, no external git process needed)
// ---------------------------------------------------------------------------
let _cachedBranch: string | null | undefined = undefined
let _cachedBranchCwd: string | undefined = undefined

export function getGitBranch(cwd: string): string | null {
  // Re-read if cwd changed
  if (_cachedBranchCwd !== cwd) {
    _cachedBranch    = undefined
    _cachedBranchCwd = cwd
  }
  if (_cachedBranch !== undefined) return _cachedBranch

  try {
    const result = execSync("git --no-optional-locks symbolic-ref --quiet --short HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim()
    _cachedBranch = result || null
  } catch {
    _cachedBranch = null
  }
  return _cachedBranch
}

/** Invalidate the git branch cache (call after CWD changes) */
export function invalidateGitBranchCache(): void {
  _cachedBranch    = undefined
  _cachedBranchCwd = undefined
}

// ---------------------------------------------------------------------------
// Main render -- now returns TWO lines: [pwdLine, statsLine]
// ---------------------------------------------------------------------------
export function renderStatusBar(p: StatusBarProps): string[] {
  const cwd = p.cwd ?? process.cwd()

  // ── Line 1: CWD + git branch ────────────────────────────────────────────
  let pwdDisplay = formatCwd(cwd)
  const branch = getGitBranch(cwd)
  if (branch) pwdDisplay += ` (${branch})`

  const pwdLine = `${T.panelBg}${padEnd(`${T.dim}${pwdDisplay}${T.reset}${T.panelBg}`, p.width)}${T.reset}`

  // ── Line 2: stats ────────────────────────────────────────────────────────

  // Left: ◆ recode  provider/model
  const logo         = `${T.panelBg}${T.bold}${T.purple}◆ recode${T.reset}${T.panelBg}`
  const providerModel = `${T.muted}${p.provider}/${truncate(p.model, 28)}${T.reset}${T.panelBg}`
  const left = `${logo} ${providerModel}`

  // Right side pieces ---

  // Scroll hint
  const scrollHint = p.scrollOffset && p.scrollOffset > 0
    ? `${T.purpleDim}↑ scrolled (PgDn/End)${T.reset}${T.panelBg}  ` : ""

  // Status dot
  const statusDot = p.isAutoCompacting
    ? `${T.orange}⠿ auto-compacting…${T.reset}${T.panelBg}`
    : p.isRunning
      ? `${T.green}● working${T.reset}${T.panelBg}`
      : `${T.dim}○ ready${T.reset}${T.panelBg}`

  // #1 -- formatted token counts
  const totalTokens = p.inputTokens + p.outputTokens
  const tokens = totalTokens > 0
    ? `  ${T.dim}↑${formatTokens(p.inputTokens)} ↓${formatTokens(p.outputTokens)}${T.reset}${T.panelBg}`
    : ""

  // #2 -- cache read/write + cache hit rate
  let cacheStr = ""
  if (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0) {
    const totalPrompt = p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens
    const hitRate = totalPrompt > 0 ? (p.cacheReadTokens / totalPrompt) * 100 : 0
    cacheStr = `  ${T.dim}R${formatTokens(p.cacheReadTokens)} W${formatTokens(p.cacheWriteTokens)} CH${hitRate.toFixed(0)}%${T.reset}${T.panelBg}`
  }

  // #3 -- smart cost formatting
  const cost = p.totalCostUsd > 0
    ? `  ${T.dim}${formatCost(p.totalCostUsd)}${T.reset}${T.panelBg}`
    : ""

  // #3 -- context window % with color warnings
  let ctxStr = ""
  if (p.contextWindow > 0 && totalTokens > 0) {
    const pct = ((p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens) / p.contextWindow) * 100
    const pctDisplay = `${pct.toFixed(1)}%/${formatTokens(p.contextWindow)}`
    if (pct > 90) {
      ctxStr = `  ${T.red}${pctDisplay}${T.reset}${T.panelBg}`           // 🔴 danger
    } else if (pct > 70) {
      ctxStr = `  ${T.orange}${pctDisplay}${T.reset}${T.panelBg}`        // 🟡 warning
    } else {
      ctxStr = `  ${T.dim}${pctDisplay}${T.reset}${T.panelBg}`           // normal
    }
  }

  // Session ID
  const sid = `  ${T.dim}#${p.sessionId.slice(0, 8)}${T.reset}${T.panelBg}`

  const right = scrollHint + statusDot + tokens + cacheStr + cost + ctxStr + sid

  const gap = Math.max(1, p.width - visibleWidth(left) - visibleWidth(right))
  const statsLine = `${T.panelBg}${padEnd(left + " ".repeat(gap) + right, p.width)}${T.reset}`

  return [pwdLine, statsLine]
}
