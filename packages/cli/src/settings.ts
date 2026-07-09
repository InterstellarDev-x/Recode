import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

export interface RecodeSettings {
  provider?: string
  model?: string
  appendSystemPrompt?: string
  compaction?: {
    enabled?: boolean
    reserveTokens?: number
    keepRecentTokens?: number
  }
  retry?: {
    enabled?: boolean
    maxRetries?: number
    baseDelayMs?: number
  }
}

const GLOBAL_SETTINGS_DIR = join(homedir(), ".recode")
const GLOBAL_SETTINGS_PATH = join(GLOBAL_SETTINGS_DIR, "settings.json")

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key]
    const bv = base[key]
    if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object") {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>) as T[keyof T]
    } else if (ov !== undefined) {
      result[key] = ov as T[keyof T]
    }
  }
  return result
}

async function loadJsonFile(path: string): Promise<RecodeSettings> {
  try {
    const text = await readFile(path, "utf-8")
    return JSON.parse(text) as RecodeSettings
  } catch {
    return {}
  }
}

export async function loadSettings(): Promise<RecodeSettings> {
  const global = await loadJsonFile(GLOBAL_SETTINGS_PATH)
  const projectPath = join(process.cwd(), ".recode", "settings.json")
  const project = existsSync(projectPath) ? await loadJsonFile(projectPath) : {}
  return deepMerge(global as Record<string, unknown>, project as Record<string, unknown>) as RecodeSettings
}

export async function saveGlobalSettings(patch: Partial<RecodeSettings>): Promise<void> {
  const existing = await loadJsonFile(GLOBAL_SETTINGS_PATH)
  const merged = deepMerge(existing as Record<string, unknown>, patch as Record<string, unknown>)
  await mkdir(GLOBAL_SETTINGS_DIR, { recursive: true })
  await writeFile(GLOBAL_SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8")
}
