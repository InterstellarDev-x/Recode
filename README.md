# Recode

A terminal-based AI coding agent, built from scratch: a full-screen TUI, a
provider-agnostic model layer across six AI providers, an agent harness with
retry/compaction/session persistence, and a sub-agent system for delegating
work to specialized child agents — the same shape of tool as Claude Code or
opencode, built to understand every layer of how one actually works.

~6,400 lines of TypeScript across three packages. Full user-facing docs in
[`GUIDE.md`](GUIDE.md); this file is the engineering overview.

## Packages

- **`packages/ai`** — the model layer. A `ProviderRegistry` behind one
  `Provider` interface, with concrete implementations for Anthropic, OpenAI,
  Azure OpenAI, Google, AWS Bedrock, and OpenRouter — switching providers
  mid-session (`/provider openai`) doesn't touch anything above this layer.
- **`packages/agent`** — the harness: `loop.ts` (the core LLM → tool → repeat
  cycle), `session.ts` (persistence, auto-resume per working directory),
  `compaction.ts` (auto-summarizes history as it approaches the context
  limit), `validate.ts`, and retry-with-backoff on top of the loop. Built-in
  tools live in `tools/`: `bash`, `read`, `write`, `edit`, `grep`, `find`,
  `ls`, and `subagent`.
- **`packages/cli`** — the terminal UI: a custom renderer and ANSI layer
  (`tui/renderer.ts`, `tui/ansi.ts`) driving five components (chat pane,
  status bar, command palette, input box, pending-messages queue), plus
  slash-command handling (`commands.ts`) and settings (`settings.ts`).

## The sub-agent system

The most involved piece: `.md` files with YAML frontmatter (`name`,
`description`, `tools`, `model`) define specialized agents, discoverable from
`~/.recode/agents/` (global) or `<project>/.recode/agents/` (project-local,
overrides global by name). The `subagent` tool can invoke them three ways —
**single** (one agent, one task), **parallel** (up to 8 tasks, 4 concurrent),
or **chain** (sequential, each step's output piped into the next via
`{previous}`) — so the main agent can delegate a reviewer, a tester, and a
documenter across a codebase without hand-rolling the orchestration each
time.

## Other things actually implemented

- **Context compaction**: automatic when nearing the model's context limit, or manual via `/compact` — either way it AI-summarizes history rather than just truncating it, and shows a collapsible summary card in the TUI.
- **Session persistence**: sessions are stored per working directory under `~/.recode/sessions/`, auto-resuming on next launch; `/sessions`, `/resume <id>`, `/new`, and `/name` manage them.
- **Headless mode**: `recode --json "<prompt>"` emits structured JSONL (`text_delta`, `tool_call_start`, `tool_result`, `turn_end`, `agent_end`) for scripting or CI, reusing the same harness the TUI drives.
- **Project context**: `AGENTS.md` / `CLAUDE.md` files are discovered by walking up from the cwd and prepended to the system prompt, the same convention these tools have converged on.

## Running it

```bash
bun install
cp .env.example .env   # fill in at least one provider's API key
bun packages/cli/src/main.ts
```

Or compile a standalone binary: `bun run bundle` (currently targets
`bun-windows-x64`, see `package.json`).

## Status

All of the above runs end to end — this isn't a docs-only sketch, the TUI,
harness, and provider layer are wired together and usable daily. See
[`GUIDE.md`](GUIDE.md) for the full command/tool/config reference.
