# Recode — User Guide

> **Recode** is an expert AI coding agent that runs directly in your terminal. It reads, writes, edits, and debugs code across any language or framework using a rich set of built-in tools and a powerful sub-agent system.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Configuration](#2-configuration)
   - [Environment Variables & API Keys](#environment-variables--api-keys)
   - [Settings File](#settings-file)
   - [Project Context Files](#project-context-files)
3. [The Terminal Interface (TUI)](#3-the-terminal-interface-tui)
   - [Layout](#layout)
   - [Keyboard Shortcuts](#keyboard-shortcuts)
4. [Slash Commands](#4-slash-commands)
   - [Model & Provider](#model--provider)
   - [Session Management](#session-management)
   - [Chat & Display](#chat--display)
   - [Utilities](#utilities)
5. [Built-in Agent Tools](#5-built-in-agent-tools)
   - [bash](#bash)
   - [read](#read)
   - [write](#write)
   - [edit](#edit)
   - [grep](#grep)
   - [find](#find)
   - [ls](#ls)
   - [subagent](#subagent)
6. [Sub-Agents System](#6-sub-agents-system)
   - [Creating an Agent](#creating-an-agent)
   - [Frontmatter Reference](#frontmatter-reference)
   - [Invocation Modes](#invocation-modes)
7. [Supported AI Providers & Models](#7-supported-ai-providers--models)
8. [Session Persistence](#8-session-persistence)
9. [Context Compaction](#9-context-compaction)
10. [Headless / JSON Mode](#10-headless--json-mode)
11. [Tips & Best Practices](#11-tips--best-practices)

---

## 1. Getting Started

### Prerequisites

- **Bun** runtime (recommended) or Node.js
- An API key for at least one supported AI provider (Anthropic, OpenAI, Google, Azure, AWS Bedrock, or OpenRouter)
- Git Bash (on Windows — Recode uses it for shell commands)

### Running Recode

```bash
# From the project root
bun packages/cli/src/main.ts

# Or if you have the compiled binary
./recode.exe
```

Recode opens a full-screen TUI in your terminal. Your last session for the current working directory **auto-resumes** on startup.

---

## 2. Configuration

### Environment Variables & API Keys

Copy `.env.example` to `.env` in your project root and fill in the relevant keys:

```env
# ── AI Provider Keys ──────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...       # Anthropic (default provider)
OPENAI_API_KEY=sk-...              # OpenAI
GOOGLE_API_KEY=...                 # Google Gemini
AZURE_OPENAI_API_KEY=...           # Azure OpenAI
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_DEPLOYMENT=...
# OPENROUTER_API_KEY=...           # OpenRouter

# ── AWS Bedrock ───────────────────────────────────────────────
AWS_SERVICE_NAME=bedrock-runtime
AWS_REGION_NAME=us-east-1
AWS_MODEL_ID=us.anthropic.claude-sonnet-4-6
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...            # if using temporary credentials
# AWS_PROFILE=default              # or use a named profile

# ── Recode Defaults ───────────────────────────────────────────
RECODE_PROVIDER=anthropic          # default provider
RECODE_MODEL=                      # leave blank to use provider default
```

> **Tip:** Recode automatically loads `.env` from the current working directory on startup. Environment variables already set in your shell take priority.

---

### Settings File

You can configure Recode persistently via JSON settings files:

| Location | Scope |
|---|---|
| `~/.recode/settings.json` | Global (applies everywhere) |
| `<project>/.recode/settings.json` | Project-local (overrides global) |

**Example `settings.json`:**

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "appendSystemPrompt": "Always respond concisely. Prefer TypeScript.",
  "compaction": {
    "enabled": true,
    "reserveTokens": 10000,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 1000
  }
}
```

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Default AI provider |
| `model` | `string` | Default model ID |
| `appendSystemPrompt` | `string` | Extra instructions appended to the system prompt |
| `compaction.enabled` | `boolean` | Enable/disable auto context compaction |
| `compaction.reserveTokens` | `number` | Tokens to reserve before triggering compaction |
| `compaction.keepRecentTokens` | `number` | Tokens of recent history to keep after compaction |
| `retry.enabled` | `boolean` | Enable/disable automatic retry on API errors |
| `retry.maxRetries` | `number` | Maximum number of retry attempts |
| `retry.baseDelayMs` | `number` | Base delay (ms) between retries (exponential backoff) |

---

### Project Context Files

Recode automatically injects project-specific instructions into every session. Place a file named `AGENTS.md` (or `CLAUDE.md`) in:

- `~/.recode/` — global instructions for all projects
- Your project root or any ancestor directory — project-specific instructions

**Example `AGENTS.md`:**

```markdown
This is a TypeScript monorepo using Bun and Turbo.
- Always use `bun` instead of `npm` or `yarn`
- Follow the existing code style in each package
- Run `bun test` to verify changes before committing
```

Recode walks up the directory tree from the current working directory, collecting all `AGENTS.md` files it finds and prepending them to the system prompt.

---

## 3. The Terminal Interface (TUI)

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chat History                             │
│  (scrollable — shows user messages, AI responses, tool output)  │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Status Bar: provider · model · session · tokens · cost · git   │
├─────────────────────────────────────────────────────────────────┤
│  Pending Messages (shown while agent is running)                │
├─────────────────────────────────────────────────────────────────┤
│  [ Command Palette — appears when you type / ]                  │
├─────────────────────────────────────────────────────────────────┤
│  Input Box: Ask anything…                          [● running]  │
└─────────────────────────────────────────────────────────────────┘
```

- **Chat History** — Displays the full conversation including user messages, AI responses, and tool call results. Scrollable at any time.
- **Status Bar** — Shows the active provider, model, session ID, cumulative token counts, estimated cost (USD), and current git branch.
- **Pending Messages** — Messages you typed while the agent was running (steer/follow-up queue).
- **Command Palette** — Auto-opens when you type `/`, showing available slash commands filtered by what you type.
- **Input Box** — Where you type your messages and commands. Supports multi-line input, history navigation, and paste.

---

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message to the agent |
| `Shift+Enter` / paste newline | Insert a newline (multi-line input) |
| `Ctrl+C` | Interrupt a running agent · Cancel compaction · Exit (when idle) |
| `Ctrl+D` | Exit Recode |
| `Ctrl+L` | Redraw / refresh the screen |
| `Ctrl+U` | Clear the entire input line |
| `Ctrl+W` | Delete the last word in input |
| `↑` / `↓` | Browse input history (persisted across restarts) |
| `←` / `→` | Move cursor left / right in input |
| `Home` / `End` | Jump to start / end of input line |
| `Page Up` / `Page Down` | Scroll chat up / down by one page |
| `Mouse wheel` | Scroll chat up / down |
| `Alt+T` | Toggle expand/collapse the last compaction summary card |

#### While the Agent is Running

| Key | Action |
|---|---|
| `Enter` | **Steer** — inject a message into the current agent turn |
| `Alt+Enter` | **Follow-up** — queue a message to run after the agent finishes |
| `Alt+↑` | **Dequeue** — restore all pending messages back to the input box |
| `Ctrl+C` | Interrupt the agent immediately |

---

## 4. Slash Commands

Type `/` in the input box to open the **Command Palette** with autocomplete. Press `Enter` on a highlighted command or type it fully.

### Model & Provider

#### `/model [id]`
List all available models or switch to a specific one.

```
/model                        → lists all models with provider and context window
/model claude-sonnet-4-5      → switches to Claude Sonnet 4.5
/model gpt-4o                 → switches to GPT-4o
```

#### `/provider [name] [model-id]`
List all providers or switch to a specific provider (optionally with a model).

```
/provider                     → lists all providers
/provider openai              → switches to OpenAI with its default model
/provider anthropic claude-3-5-sonnet-20241022
```

**Available providers:** `anthropic`, `openai`, `azure`, `google`, `bedrock`, `openrouter`

---

### Session Management

#### `/session`
Show detailed info about the current session: ID, name, entry count, token usage, cache stats, cost, provider, model, and working directory.

#### `/sessions`
List all saved sessions for the current directory, showing their name/ID, relative age, and cost.

#### `/new`
Start a brand-new session. Clears the chat and resets token counters. The new session will auto-resume next time you open Recode in this directory.

#### `/resume <session-id>`
Resume a previously saved session by its ID (shown by `/sessions`).

```
/resume a1b2c3d4
```

#### `/name <text>`
Set a human-readable display name for the current session.

```
/name "auth refactor"
```

#### `/export [path]`
Export the entire conversation to a plain-text file.

```
/export                       → saves to recode-session-<id>.txt in cwd
/export ~/Desktop/chat.txt    → saves to a specific path
```

---

### Chat & Display

#### `/clear`
Clears the visible chat history **and** resets the agent's context (starts a fresh session). Use this when you want a completely clean slate.

#### `/compact`
Manually trigger **AI-powered context compaction**. The agent summarises the conversation history into a compact summary, freeing up context window space without losing important information. A collapsible summary card appears in the chat — press `Alt+T` to expand/collapse it.

> See [Section 9 — Context Compaction](#9-context-compaction) for more details.

---

### Utilities

#### `/copy`
Copy the last assistant message to the clipboard (uses `clip.exe` on Windows).

#### `/hotkeys`
Display the keyboard shortcuts reference panel.

#### `/help`
Display the full slash commands reference.

#### `/quit` · `/exit` · `/q`
Exit Recode.

---

## 5. Built-in Agent Tools

Recode gives the AI agent access to the following tools to interact with your system. The agent decides which tools to use based on your request.

---

### `bash`
**Run a shell command and return its output.**

- Executes in the current working directory by default
- Uses Git Bash on Windows for POSIX compatibility (`ls`, `grep`, `find`, etc.)
- **Timeout:** 120 seconds — commands exceeding this are killed
- Returns stdout + stderr combined; non-zero exit codes are reported

**Example usage (the agent does this for you):**
```
Run: git status
Run: bun install
Run: npm test -- --watch
```

---

### `read`
**Read the contents of a file.**

- Supports optional `offset` (start line, 1-indexed) and `limit` (max lines to read)
- Useful for reading large files in chunks
- Returns the file contents as text

---

### `write`
**Write content to a file, creating parent directories as needed.**

- **Overwrites** the file if it already exists
- Creates any missing directories in the path automatically
- Use [`edit`](#edit) instead when you only need to change a portion of a file

---

### `edit`
**Replace an exact string in a file with new content.**

- The `old_string` must appear **exactly once** in the file (unique match required)
- Makes targeted, surgical edits without rewriting the whole file
- The agent always reads the file first, then uses `edit` for precision changes

---

### `grep`
**Search for a regex pattern across files.**

- Returns `file:line: content` matches
- Supports `glob` filtering (e.g. `*.ts`, `*.py`) and `case_insensitive` mode
- Searches recursively through directories

---

### `find`
**Find files or directories by name pattern.**

- Accepts glob patterns (e.g. `*.json`, `package.json`) or exact names
- Supports `max_depth` to limit traversal depth
- Returns matching file/directory paths

---

### `ls`
**List files and directories at a given path.**

- Returns the directory listing with file sizes
- Defaults to the current working directory if no path is given

---

### `subagent`
**Delegate tasks to specialised sub-agents.**

This is Recode's most powerful tool — it lets the main agent spawn specialised child agents to handle parallel workloads, sequential pipelines, or domain-specific tasks. See [Section 6 — Sub-Agents System](#6-sub-agents-system) for the full guide.

---

## 6. Sub-Agents System

Sub-agents are specialised AI instances defined as Markdown files. The main Recode agent can delegate tasks to them using the `subagent` tool.

### Creating an Agent

Create a `.md` file in one of these locations:

| Location | Scope |
|---|---|
| `~/.recode/agents/<name>.md` | User-global (available in all projects) |
| `<project>/.recode/agents/<name>.md` | Project-local (overrides global agents with the same name) |

**Example: `~/.recode/agents/reviewer.md`**

```markdown
---
name: reviewer
description: Reviews code for correctness, style, and potential bugs
tools: read,grep,find
model: claude-3-5-haiku-20241022
---

You are a strict code reviewer. When given code or a file path:
1. Read the file carefully
2. Check for bugs, edge cases, and style issues
3. Return a concise bullet-point review with severity labels (critical / warning / suggestion)
```

---

### Frontmatter Reference

Every agent file starts with a YAML frontmatter block between `---` markers:

| Field | Required | Description |
|---|---|---|
| `name` | ✅ Yes | Unique identifier used to invoke the agent (e.g. `reviewer`) |
| `description` | No | Short description shown in tool help text |
| `tools` | No | Comma-separated list of tools available to this agent. Defaults to all tools if omitted. |
| `model` | No | Model ID override. Falls back to the parent agent's model if omitted. |

**Available tool names for the `tools` field:**
`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `subagent`

---

### Invocation Modes

Sub-agents can be invoked in three modes. The main agent chooses the right one based on your task.

#### Single Mode
Run one agent on one task:

```json
{
  "agent": "reviewer",
  "task": "Review the file src/auth.ts for security issues",
  "cwd": "/path/to/project"
}
```

#### Parallel Mode
Run multiple agents concurrently (up to 8 tasks, 4 at a time):

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review src/auth.ts" },
    { "agent": "reviewer", "task": "Review src/api.ts" },
    { "agent": "tester",   "task": "Write tests for src/utils.ts" }
  ]
}
```

Results are returned as separate labeled blocks per task.

#### Chain Mode
Run agents sequentially, passing each output to the next step via `{previous}`:

```json
{
  "chain": [
    { "agent": "analyzer",  "task": "Analyze the codebase structure" },
    { "agent": "planner",   "task": "Based on this analysis, create a refactoring plan:\n{previous}" },
    { "agent": "coder",     "task": "Implement the first step of this plan:\n{previous}" }
  ]
}
```

---

## 7. Supported AI Providers & Models

Use `/model` to see the full list. Here is a summary of all supported providers and their key models:

### Anthropic
| Model ID | Display Name | Context |
|---|---|---|
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | 200k |
| `claude-opus-4-8` | Claude Opus 4.8 | 200k |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | 200k |
| `claude-3-5-sonnet-20241022` | Claude 3.5 Sonnet | 200k |
| `claude-3-5-haiku-20241022` | Claude 3.5 Haiku | 200k |

### OpenAI
| Model ID | Display Name | Context |
|---|---|---|
| `gpt-4o` | GPT-4o | 128k |
| `gpt-4o-mini` | GPT-4o Mini | 128k |
| `o3` | o3 | 200k |
| `o3-mini` | o3-mini | 128k |
| `o1` | o1 | 200k |

### Google
| Model ID | Display Name | Context |
|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1M |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1M |
| `gemini-2.0-flash` | Gemini 2.0 Flash | 1M |
| `gemini-1.5-pro` | Gemini 1.5 Pro | 2M |

### AWS Bedrock
| Model ID | Display Name |
|---|---|
| `us.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 (Bedrock) |
| `us.anthropic.claude-sonnet-4-5-20251001-v1:0` | Claude Sonnet 4.5 (Bedrock) |
| `us.anthropic.claude-opus-4-5-20251101-v1:0` | Claude Opus 4.5 (Bedrock) |

### OpenRouter
Access hundreds of models through a single API key (`OPENROUTER_API_KEY`):

| Model ID | Description |
|---|---|
| `openrouter/auto` | Automatically selects the best model |
| `openrouter/anthropic/claude-sonnet-4-5` | Claude via OpenRouter |
| `openrouter/openai/gpt-4o` | GPT-4o via OpenRouter |
| `openrouter/google/gemini-2.0-flash` | Gemini via OpenRouter |
| `openrouter/meta-llama/llama-3.1-405b-instruct` | Llama 3.1 405B |
| `openrouter/deepseek/deepseek-chat` | DeepSeek Chat |

### Azure OpenAI
Configure via `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and `AZURE_OPENAI_DEPLOYMENT` in your `.env` file.

---

## 8. Session Persistence

Recode automatically saves your conversation history so you never lose your work.

### How It Works

- Sessions are stored in `~/.recode/sessions/` organised by working directory
- **Auto-resume:** When you open Recode in a directory, it automatically loads the last session for that directory
- **Input history:** Your typed inputs are saved to `~/.recode/history.txt` and browsable with `↑`/`↓`
- **Cumulative stats:** Token counts and cost are persisted and restored on resume

### Managing Sessions

```
/session          → view current session details (tokens, cost, ID, name)
/sessions         → list all sessions for the current directory with ages
/new              → start a fresh session (old one is preserved)
/resume <id>      → load a specific past session
/name "my task"   → give the current session a memorable name
/export           → save the conversation to a text file
```

### Session File Location
```
~/.recode/
  sessions/
    <cwd-hash>/
      <session-id>.json    ← session data
  history.txt              ← input history
  settings.json            ← global settings
  agents/                  ← global agent definitions
```

---

## 9. Context Compaction

Long conversations consume large amounts of the model's context window, which increases cost and can eventually hit limits. Recode handles this in two ways:

### Auto-Compaction
When the context usage approaches the model's limit, Recode **automatically** compacts the conversation:

1. The agent finishes its current response
2. A spinner appears: `⠿ Auto-compacting…`
3. Recode uses the AI to summarise the conversation history
4. The summary replaces the old messages, freeing up context
5. A collapsible **Compaction Summary Card** appears in the chat

You can still type during auto-compaction — messages are **queued** and delivered after it completes. Press `Esc` or `Ctrl+C` to cancel.

### Manual Compaction
Run `/compact` at any time to manually trigger compaction. Useful before starting a new sub-topic in a long session.

### Compaction Summary Card
After compaction, a card like this appears in the chat:

```
┌ ⠿ Context compacted  (was ~45,000 tokens)
│ [collapsed — press Alt+T to expand]
└──────────────────────────────────────────
```

Press **`Alt+T`** to toggle the full summary.

---

## 10. Headless / JSON Mode

Recode can be run non-interactively, emitting structured JSONL to stdout. This is used internally by the sub-agent system and can also be used to integrate Recode into scripts and CI pipelines.

### Usage

```bash
recode --json "Refactor the auth module to use JWT tokens"
recode --json --model claude-3-5-haiku-20241022 "Summarize this file" 
recode --json --no-session --tools read,grep "What does the main.ts file do?"
```

### CLI Flags

| Flag | Description |
|---|---|
| `--json` | Enable headless JSON mode (no TUI) |
| `--no-session` | Run without persisting the session |
| `--model <id>` | Override the model for this run |
| `--tools <list>` | Comma-separated list of allowed tools (e.g. `read,grep,find`) |
| `--append-system-prompt <file>` | Path to a file whose contents are appended to the system prompt |
| `<prompt>` | The task prompt as a positional argument |

### JSONL Output Events

Each line of output is a JSON object:

| Event | Fields | Description |
|---|---|---|
| `text_delta` | `delta: string` | Streaming text chunk from the model |
| `tool_call_start` | `id, name` | Agent is calling a tool |
| `tool_result` | `name, result, isError` | Tool execution result |
| `turn_end` | `usage: {...}` | End of one LLM turn with token usage |
| `agent_end` | `reason: "done"\|"max_turns"\|"interrupted"\|"error"` | Agent has finished |
| `error` | `message: string` | An error occurred |

### Example Script

```bash
#!/bin/bash
recode --json --no-session "List all TypeScript files in the src directory" \
  | grep '"type":"text_delta"' \
  | jq -r '.delta' \
  | tr -d '\n'
```

---

## 11. Tips & Best Practices

### Be Specific with Tasks
Instead of:
> "Fix the bug"

Try:
> "The login function in `src/auth.ts` throws a null pointer error when the user object has no email field. Fix it and add a test."

### Use Project Context Files
Add an `AGENTS.md` to your project root with your conventions, stack details, and coding standards. Recode will follow them consistently across all sessions.

```markdown
# AGENTS.md
- This is a Next.js 14 app using the App Router
- Use Tailwind CSS for all styling — no inline styles
- All API routes go in src/app/api/
- Run `bun lint` and `bun test` before finishing any task
```

### Leverage Sub-Agents for Big Tasks
When working on large codebases, create specialised agents for different roles:

```
~/.recode/agents/
  reviewer.md      → code review with strict style checking
  tester.md        → writes unit and integration tests
  documenter.md    → generates JSDoc / README content
  refactorer.md    → restructures code while preserving behaviour
```

Then ask Recode to coordinate them:
> "Use the reviewer and tester agents in parallel to review and write tests for all files in src/api/"

### Steer the Agent Mid-Task
If Recode is heading in the wrong direction, press `Enter` while it's running to inject a **steer message** — it will adjust its approach mid-turn without starting over.

### Use `/compact` Proactively
Before tackling a new feature in a long session, run `/compact` to clear old context and reduce costs. The summary keeps all important decisions intact.

### Manage Multiple Workstreams with `/new`
Use `/new` to start fresh sessions per feature or task, and `/sessions` to switch between them with `/resume`. Name them with `/name` for easy identification.

### Restrict Tool Access for Sub-Agents
Give sub-agents only the tools they need:

```markdown
---
name: reader
description: Reads and summarizes files only
tools: read,ls,find
---
```

This improves safety and performance for agents that don't need write access.

---


