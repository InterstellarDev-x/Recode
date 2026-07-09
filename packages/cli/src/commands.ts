import { MODELS, modelsForProvider } from "@recode/ai"
import type { ProviderName } from "@recode/ai"

export type CommandResult =
  | { type: "not_a_command"; text: string }
  | { type: "quit" }
  | { type: "show_output"; lines: string[] }
  | { type: "clear_chat" }
  | { type: "compact" }
  | { type: "new_session" }
  | { type: "set_model"; model: string }
  | { type: "set_provider"; provider: ProviderName; model: string }
  | { type: "resume_session"; sessionId: string }
  | { type: "export_session"; path?: string }
  | { type: "set_name"; name: string }
  | { type: "copy_last" }
  | { type: "show_session_info" }
  | { type: "list_sessions" }

const PROVIDERS: ProviderName[] = ["anthropic", "openai", "azure", "google", "bedrock", "openrouter"]

export function handleCommand(input: string): CommandResult {
  if (!input.startsWith("/")) return { type: "not_a_command", text: input }
  const parts = input.slice(1).trim().split(/\s+/)
  const cmd = parts[0] ?? ""
  const args = parts.slice(1)
  const rest = args.join(" ")

  switch (cmd) {
    // ── Navigation / lifecycle ───────────────────────────────────────
    case "quit":
    case "exit":
    case "q":
      return { type: "quit" }

    case "new":
      return { type: "new_session" }

    case "resume": {
      const id = args[0]
      if (!id) return { type: "show_output", lines: ["Usage: /resume <session-id>", "Use /sessions to list sessions."] }
      return { type: "resume_session", sessionId: id }
    }

    // ── Chat display ─────────────────────────────────────────────────
    case "clear":
      return { type: "clear_chat" }

    case "compact":
      return { type: "compact" }

    case "copy":
      return { type: "copy_last" }

    // ── Session management ───────────────────────────────────────────
    case "session":
      return { type: "show_session_info" }

    case "sessions":
      return { type: "list_sessions" }

    case "name": {
      if (!rest) return { type: "show_output", lines: ["Usage: /name <display name>"] }
      return { type: "set_name", name: rest }
    }

    case "export": {
      const path = args[0]
      return { type: "export_session", ...(path ? { path } : {}) }
    }

    // ── Model / provider ─────────────────────────────────────────────
    case "model": {
      const id = args[0]
      if (!id) {
        const rows = MODELS.map(
          (m) => `  ${m.id.padEnd(44)} ${m.provider.padEnd(10)} ${(m.contextWindow / 1000).toFixed(0)}k ctx`,
        )
        return { type: "show_output", lines: ["Available models:", "", ...rows, "", "Usage: /model <id>"] }
      }
      const found = MODELS.find((m) => m.id === id)
      if (!found) return { type: "show_output", lines: [`Unknown model: ${id}`, "Use /model to list all models."] }
      return { type: "set_model", model: id }
    }

    case "provider": {
      const name = args[0] as ProviderName | undefined
      if (!name) {
        return {
          type: "show_output",
          lines: [
            "Providers:",
            "  anthropic   Direct Anthropic API",
            "  openai      OpenAI API",
            "  azure       Azure OpenAI",
            "  google      Google Gemini",
            "  bedrock     Anthropic via AWS Bedrock",
            "  openrouter  OpenRouter (access 100s of models, set OPENROUTER_API_KEY)",
            "",
            "Usage: /provider <name> [model-id]",
          ],
        }
      }
      if (!PROVIDERS.includes(name)) {
        return { type: "show_output", lines: [`Unknown provider: ${name}`, `Valid: ${PROVIDERS.join("  ")}`] }
      }
      const model = args[1] ?? modelsForProvider(name)[0]?.id ?? ""
      return { type: "set_provider", provider: name, model }
    }

    // ── Help ─────────────────────────────────────────────────────────
    case "hotkeys":
      return {
        type: "show_output",
        lines: [
          "Keyboard shortcuts:",
          "",
          "  Enter          Send message",
          "  Ctrl+C         Interrupt agent / exit",
          "  Ctrl+D         Exit",
          "  Ctrl+L         Redraw screen",
          "  Ctrl+U         Clear input line",
          "  Ctrl+W         Delete last word",
          "  Up / Down      Browse input history (persisted across restarts)",
          "  Left / Right   Move cursor",
          "  Home / End     Jump to start / end of line",
          "  PgUp / PgDn    Scroll chat (works during streaming too)",
          "  Mouse wheel    Scroll chat",
        ],
      }

    case "help":
      return {
        type: "show_output",
        lines: [
          "Slash commands:",
          "",
          "  /model [id]          List models or switch model",
          "  /provider [name]     List providers or switch provider",
          "  /session             Show current session info (id, tokens, cost)",
          "  /sessions            List sessions for this directory",
          "  /resume <id>         Resume a previous session",
          "  /new                 Start a new session",
          "  /name <text>         Set a display name for this session",
          "  /export [path]       Export conversation to file",
          "  /copy                Copy last assistant message to clipboard",
          "  /compact             AI-summarise context to save tokens",
          "  /clear               Clear chat display AND reset context",
          "  /hotkeys             Show keyboard shortcuts",
          "  /quit                Exit recode",
          "",
          "Session persistence:",
          "  • Sessions are saved to ~/.recode/sessions/",
          "  • Your last session auto-resumes when you reopen recode here",
          "  • Input history persists across restarts (~/.recode/history.txt)",
        ],
      }

    default:
      return { type: "show_output", lines: [`Unknown command: /${cmd}`, "Type /help to see all commands."] }
  }
}
