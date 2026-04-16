# Claude Code Session Recovery

Recover Claude Code sessions that disappear from the Claude Desktop app after crashes, BSODs, or disk corruption.

> **Wrong problem?** If Claude Desktop itself won't install or update (HRESULT `0x80073CF6` / `0x80073D05`), that's a Windows MSIX-layer issue this tool can't fix — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for the ghost-AppX recovery recipe. If sessions are missing *after* a successful install/reinstall, you're in the right place; keep reading.

## The Problem

Claude Code stores session conversations as JSONL files on disk:
```
~/.claude/projects/<project-name>/<session-id>.jsonl
```

The Claude Desktop app maintains a **separate index** of these sessions in its own app data directory. When that index gets corrupted (common after BSODs, hard shutdowns, or disk errors), sessions disappear from the Desktop UI — even though **all conversation data is intact on disk**.

This tool rebuilds that index.

## Quick Start

```bash
# See what sessions exist on disk
python recover.py list

# Preview what would be restored (no changes made)
python recover.py restore --dry-run

# Restore missing sessions to Claude Desktop
python recover.py restore

# Restart Claude Desktop — your sessions are back
```

## Requirements

- Python 3.8+
- No external dependencies (stdlib only)
- Works on Windows, macOS, and Linux

## Things to Try

1. **Run `python recover.py list`** — prints every session JSONL file on disk with date, size, first-message preview, and a ready-to-run `claude --resume` command for each.
2. **Run `python recover.py restore --dry-run`** — shows exactly which sessions are missing from the Desktop app index without making any changes; safe to run any time.
3. **Run `python recover.py restore` then restart Claude Desktop** — missing sessions reappear in the sidebar; run it again and it safely skips already-registered sessions.
4. **Run `python recover.py export --export-dir ~/session-exports`** — writes every session as a readable plain-text transcript to the specified folder; useful for full-text search or archival.
5. **Run `python recover.py list --project "my-project" --json`** — outputs structured JSON of all sessions under that project, ready to pipe into `jq` or another tool.

## Commands

### `list` — Find sessions on disk

```bash
python recover.py list                      # List all sessions
python recover.py list --json               # Output as JSON for scripting
python recover.py list --project "website"  # Filter by project name
```

Shows every session JSONL file found, with date, size, a preview of the first message, and the `claude --resume` command to reopen it from CLI.

### `restore` — Re-register sessions in Desktop app

```bash
python recover.py restore                   # Restore all missing sessions
python recover.py restore --dry-run         # Preview without changes
python recover.py restore --project "kb"    # Only restore matching sessions
```

Creates registration files that tell the Claude Desktop app about sessions it lost track of. Sessions already registered are skipped (safe to run multiple times).

**You must restart Claude Desktop after running this.**

### `export` — Export transcripts to text files

```bash
python recover.py export                              # Export to ./exported-sessions/
python recover.py export --export-dir ~/my-exports    # Custom output directory
```

Exports each session as a readable text file with human/assistant messages.

## How It Works

### Session Storage Architecture

```
~/.claude/
  projects/
    D--MyProject/
      <session-id-1>.jsonl     # Conversation data (human + assistant messages)
      <session-id-2>.jsonl     # Each session = one JSONL file
      memory/                  # Project memory (not sessions)

<app-data>/Claude/
  claude-code-sessions/
    <org-uuid>/
      <user-uuid>/
        local_<uuid>.json      # Desktop app's index entry for each session
```

The Desktop app reads from `claude-code-sessions/` to populate its session list. Each `local_*.json` file is a small metadata record containing:

```json
{
  "sessionId": "local_<uuid>",
  "cliSessionId": "<session-id>",     // Points to the .jsonl file
  "cwd": "D:\\MyProject",
  "title": "Fix the auth bug",
  "createdAt": 1775192275241,
  "lastActivityAt": 1775233240735,
  "model": "claude-sonnet-4-20250514",
  "isArchived": false
}
```

When these index files are lost (corruption, reinstall, etc.), the Desktop app can't find the sessions — but the actual conversation data in `.claude/projects/` is untouched. This tool recreates the missing index files.

### What `restore` Does

1. Scans `~/.claude/projects/` for all `.jsonl` session files
2. Reads `claude-code-sessions/` to find which sessions are already registered
3. For each unregistered session, creates a `local_<uuid>.json` with metadata extracted from the JSONL file
4. Uses an existing registration file as a template for settings like model and permission mode

### Safety

- **Non-destructive**: Only creates new files, never modifies or deletes existing ones
- **Idempotent**: Safe to run multiple times — already-registered sessions are skipped
- **Dry run**: Use `--dry-run` to preview changes before committing

## MCP Server — Search Sessions from Inside Claude

The MCP server lets Claude search your session history during conversations. Ask things like:
- "What did we discuss about auth last week?"
- "Find the session where we set up the database"
- "Search my history for voicebox"

### Setup

1. Install dependencies:
```bash
cd mcp-server && npm install
```

2. Add to your Claude Desktop config:

**Windows** (`%APPDATA%\Claude\claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "session-search": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-session-recovery\\mcp-server\\index.mjs"]
    }
  }
}
```

**macOS** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "session-search": {
      "command": "node",
      "args": ["/path/to/claude-session-recovery/mcp-server/index.mjs"]
    }
  }
}
```

3. Restart Claude Desktop.

### Available Tools

| Tool | Description |
|------|-------------|
| `search_sessions` | Search all sessions for a keyword/phrase. Returns ranked results with context snippets. |
| `list_sessions` | List recent sessions with dates, projects, and previews. |

Claude will automatically use these tools when you ask about past conversations.

## Common Scenarios

### "Sessions disappeared after a BSOD/crash"
```bash
python recover.py restore
# Restart Claude Desktop
```

### "I reinstalled Claude Desktop and lost my history"
Same fix — the session data survives in `~/.claude/projects/`:
```bash
python recover.py restore
```

### "I want to resume a specific old session from CLI"
```bash
python recover.py list
# Find the session ID, then:
claude --resume <session-id>
```

### "I want to back up all my sessions as readable text"
```bash
python recover.py export --export-dir ~/claude-backups
```

## Troubleshooting

### "Could not find Claude Desktop session directory"
The Desktop app hasn't created its session directory yet. Open Claude Desktop, start one Code session through it, then run `restore` again.

### "All sessions are already registered"
The Desktop app's index is intact. If sessions still aren't showing, the issue may be elsewhere — try restarting the app or checking for updates.

### Sessions show up but can't be resumed
The session JSONL file may be corrupted (e.g., truncated write during crash). Try `python recover.py export` to extract whatever conversation data is recoverable.

## Background

This tool was built during a real recovery session after a Windows BSOD corrupted the Claude Desktop app's session index on a machine with 34 sessions across 8 projects. All session data was intact on disk — only the Desktop app's index was lost. The `restore` command rebuilt the index in seconds and all sessions reappeared after restarting the app.

## License

MIT
