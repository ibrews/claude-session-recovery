# Claude Code Session Recovery

Recover Claude Code sessions that disappear from the Claude Desktop app after crashes, BSODs, or disk corruption.

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
