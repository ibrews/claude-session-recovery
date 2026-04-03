#!/usr/bin/env node
/**
 * Claude Session Search — MCP Server
 *
 * Exposes Claude Code session search, list, and restore as MCP tools
 * so Claude can search your conversation history mid-session.
 *
 * Add to claude_desktop_config.json:
 *   "session-search": {
 *     "command": "node",
 *     "args": ["<path-to>/mcp-server/index.mjs"]
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir, platform } from "os";
import { globSync } from "fs";

// --- Path Discovery ---

function findClaudeDir() {
  const home = homedir();
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) return claudeDir;

  // Windows fallback
  if (platform() === "win32") {
    const username = process.env.USERNAME || "";
    const alt = join("C:", "Users", username, ".claude");
    if (existsSync(alt)) return alt;
  }

  return null;
}

function findDesktopSessionsDir() {
  let base;
  if (platform() === "win32") {
    base = join(process.env.APPDATA || "", "Claude", "claude-code-sessions");
  } else if (platform() === "darwin") {
    base = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    base = join(xdg, "Claude", "claude-code-sessions");
  }

  if (!existsSync(base)) return null;

  // Find org/user subdirectory (two levels of UUIDs)
  try {
    for (const org of readdirSync(base)) {
      const orgPath = join(base, org);
      if (!statSync(orgPath).isDirectory()) continue;
      for (const user of readdirSync(orgPath)) {
        const userPath = join(orgPath, user);
        if (statSync(userPath).isDirectory()) return userPath;
      }
    }
  } catch {}
  return null;
}

// --- Session Helpers ---

function findSessionFiles(claudeDir, projectFilter) {
  const projectsDir = join(claudeDir, "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions = [];
  try {
    for (const project of readdirSync(projectsDir)) {
      const projectPath = join(projectsDir, project);
      if (!statSync(projectPath).isDirectory()) continue;
      if (projectFilter && !project.toLowerCase().includes(projectFilter.toLowerCase())) continue;

      for (const file of readdirSync(projectPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.replace(".jsonl", "");
        if (sessionId.length < 30 || !sessionId.includes("-")) continue;

        const filepath = join(projectPath, file);
        const stat = statSync(filepath);

        sessions.push({
          id: sessionId,
          project,
          filepath,
          modified: stat.mtime,
          sizeKB: Math.round(stat.size / 1024),
        });
      }
    }
  } catch {}

  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

function extractCwd(filepath) {
  try {
    const content = readFileSync(filepath, { encoding: "utf-8" }).slice(0, 20000);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line.trim());
        const cwd = obj.cwd || obj.workingDirectory || obj.originCwd;
        if (cwd) return cwd;
      } catch {}
    }
  } catch {}
  return null;
}

function extractPreview(filepath) {
  try {
    const content = readFileSync(filepath, { encoding: "utf-8" }).slice(0, 50000);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line.trim());
        const t = obj.type || "";

        if (t === "queue-operation" && obj.operation === "enqueue") {
          const c = obj.content || "";
          if (c.length > 3) return c.slice(0, 120).replace(/\n/g, " ").trim();
        }

        if (t === "human" || obj.role === "human") {
          const msg = obj.message || {};
          if (typeof msg.content === "string" && msg.content.length > 3) {
            return msg.content.slice(0, 120).replace(/\n/g, " ").trim();
          }
          if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c?.type === "text" && c.text?.length > 3) {
                return c.text.slice(0, 120).replace(/\n/g, " ").trim();
              }
            }
          }
        }

        if (obj.summary) return obj.summary.slice(0, 120).replace(/\n/g, " ").trim();
      } catch {}
    }
  } catch {}
  return "(no preview)";
}

function getSessionTitle(sessionId, desktopDir) {
  if (!desktopDir) return null;
  try {
    for (const file of readdirSync(desktopDir)) {
      if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
      const data = JSON.parse(readFileSync(join(desktopDir, file), "utf-8"));
      if (data.cliSessionId === sessionId) return data.title;
    }
  } catch {}
  return null;
}

// Cache title map for performance
let titleCache = null;
function buildTitleCache(desktopDir) {
  if (titleCache) return titleCache;
  titleCache = {};
  if (!desktopDir) return titleCache;
  try {
    for (const file of readdirSync(desktopDir)) {
      if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
      const data = JSON.parse(readFileSync(join(desktopDir, file), "utf-8"));
      if (data.cliSessionId) titleCache[data.cliSessionId] = data.title || "";
    }
  } catch {}
  return titleCache;
}

// --- MCP Server ---

const server = new McpServer({
  name: "session-search",
  version: "1.0.0",
});

const claudeDir = findClaudeDir();
const desktopDir = findDesktopSessionsDir();

server.tool(
  "search_sessions",
  "Search across all Claude Code session conversations for a keyword or phrase. Returns matching sessions ranked by relevance with context snippets showing where matches occur.",
  {
    query: z.string().describe("Search term to find in session conversations"),
    max_results: z.number().optional().default(10).describe("Maximum number of sessions to return (default 10)"),
    context_snippets: z.number().optional().default(3).describe("Number of context snippets per session (default 3)"),
    project: z.string().optional().describe("Filter by project name substring"),
  },
  async ({ query, max_results, context_snippets, project }) => {
    if (!claudeDir) {
      return { content: [{ type: "text", text: "ERROR: Could not find ~/.claude directory." }] };
    }

    const sessions = findSessionFiles(claudeDir, project);
    const titles = buildTitleCache(desktopDir);
    const queryLower = query.toLowerCase();
    const results = [];

    for (const session of sessions) {
      let content;
      try {
        content = readFileSync(session.filepath, { encoding: "utf-8" });
      } catch { continue; }

      const contentLower = content.toLowerCase();
      let matchCount = 0;
      let idx = 0;
      while ((idx = contentLower.indexOf(queryLower, idx)) !== -1) {
        matchCount++;
        idx += queryLower.length;
      }

      if (matchCount === 0) continue;

      // Extract context snippets
      const snippets = [];
      idx = 0;
      while (snippets.length < context_snippets) {
        const pos = contentLower.indexOf(queryLower, idx);
        if (pos === -1) break;
        const start = Math.max(0, pos - 80);
        const end = Math.min(content.length, pos + query.length + 80);
        let snippet = content.slice(start, end).replace(/\n/g, " ").trim();
        snippets.push(snippet);
        idx = pos + query.length;
      }

      const title = titles[session.id] || extractPreview(session.filepath).slice(0, 60);
      const cwd = extractCwd(session.filepath) || session.project;

      results.push({
        sessionId: session.id,
        project: session.project,
        title,
        cwd,
        date: session.modified.toISOString().split("T")[0],
        matchCount,
        sizeKB: session.sizeKB,
        snippets,
      });
    }

    results.sort((a, b) => b.matchCount - a.matchCount);
    const topResults = results.slice(0, max_results);

    if (topResults.length === 0) {
      return { content: [{ type: "text", text: `No sessions contain "${query}".` }] };
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);
    let output = `Found "${query}" in ${results.length} sessions (${totalMatches} total matches)\n\n`;

    for (const [i, r] of topResults.entries()) {
      output += `${i + 1}. [${r.date}] ${r.matchCount} matches — ${r.title}\n`;
      output += `   Project: ${r.project} | CWD: ${r.cwd}\n`;
      output += `   Resume: claude --resume ${r.sessionId}\n`;
      for (const s of r.snippets) {
        output += `   > ${s.slice(0, 150)}\n`;
      }
      output += "\n";
    }

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "list_sessions",
  "List all Claude Code sessions on disk with dates, projects, and previews. Useful for finding recent sessions or getting an overview of conversation history.",
  {
    limit: z.number().optional().default(20).describe("Maximum sessions to return (default 20)"),
    project: z.string().optional().describe("Filter by project name substring"),
  },
  async ({ limit, project }) => {
    if (!claudeDir) {
      return { content: [{ type: "text", text: "ERROR: Could not find ~/.claude directory." }] };
    }

    const sessions = findSessionFiles(claudeDir, project).slice(0, limit);
    const titles = buildTitleCache(desktopDir);

    if (sessions.length === 0) {
      return { content: [{ type: "text", text: "No sessions found." }] };
    }

    let output = `Found ${sessions.length} sessions:\n\n`;
    for (const [i, s] of sessions.entries()) {
      const title = titles[s.id] || extractPreview(s.filepath).slice(0, 60);
      const date = s.modified.toISOString().split("T")[0];
      const size = s.sizeKB < 1024 ? `${s.sizeKB}KB` : `${(s.sizeKB / 1024).toFixed(1)}MB`;
      const cwd = extractCwd(s.filepath) || s.project;
      output += `${i + 1}. [${date}] ${size} — ${title}\n`;
      output += `   Project: ${s.project} | CWD: ${cwd}\n`;
      output += `   Resume: claude --resume ${s.id}\n\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
