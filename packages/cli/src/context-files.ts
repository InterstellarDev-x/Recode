import { homedir } from "node:os"
import { join, dirname, parse as parsePath } from "node:path"
import { existsSync, readFileSync } from "node:fs"

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]

function loadFromDir(dir: string): { path: string; content: string } | null {
  for (const name of CANDIDATES) {
    const filePath = join(dir, name)
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8")
        return { path: filePath, content }
      } catch {
        return null
      }
    }
  }
  return null
}

export function loadProjectContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = []

  // Global ~/.recode context
  const globalDir = join(homedir(), ".recode")
  const globalFile = loadFromDir(globalDir)
  if (globalFile) results.push(globalFile)

  // Walk from filesystem root to cwd, collecting ancestor files
  // Build the ancestor chain (root → ... → cwd)
  const chain: string[] = []
  let current = cwd
  while (true) {
    chain.unshift(current)
    const parent = dirname(current)
    if (parent === current) break  // reached root
    current = parent
  }

  for (const dir of chain) {
    const file = loadFromDir(dir)
    if (file) results.push(file)
  }

  return results
}
