import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentTool } from "../types.js"

/**
 * On Windows, try to find Git Bash so we can run bash commands instead of cmd.exe.
 * Searches common installation locations + any bash.exe already on PATH.
 */
function findWindowsBash(): string | null {
  // Common Git for Windows installation paths
  const candidates = [
    // Per-user install (winget / manual)
    join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "bin", "bash.exe"),
    // System-wide install
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    // WSL bash (Windows Subsystem for Linux)
    "C:\\Windows\\System32\\bash.exe",
    // Git installed at drive root
    "C:\\Git\\bin\\bash.exe",
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

// Resolve once at module load time so we don't stat on every command
const WIN_BASH = process.platform === "win32" ? findWindowsBash() : null

export const bashTool: AgentTool = {
  definition: {
    name: "bash",
    description: "Run a shell command and return its output. Times out after 120 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },

  async execute(input: unknown): Promise<string> {
    const { command, cwd } = input as { command: string; cwd?: string }
    return new Promise((resolve) => {
      const isWindows = process.platform === "win32"

      // Prefer Git Bash on Windows for POSIX command compatibility (ls, grep, find, etc.)
      const shell = isWindows
        ? (WIN_BASH ?? "cmd.exe")
        : "/bin/sh"
      const shellArgs = isWindows
        ? (WIN_BASH ? ["-c", command] : ["/c", command])
        : ["-c", command]

      const child = spawn(shell, shellArgs, {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })

      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString() })
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString() })

      const timer = setTimeout(() => { child.kill(); resolve("<timeout>Command timed out after 120s</timeout>") }, 120_000)

      child.on("close", (code) => {
        clearTimeout(timer)
        const out = [stdout, stderr].filter(Boolean).join("\n").trim()
        resolve(code !== 0 ? `<exit_code>${code}</exit_code>\n${out}` : out || "(no output)")
      })
      child.on("error", (err) => { clearTimeout(timer); resolve(`<error>${err.message}</error>`) })
    })
  },
}
