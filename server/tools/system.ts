/**
 * System Tools
 *
 * Core tools for interacting with the local system:
 * - File system (LIST_FILES, READ_FILE)
 * - Shell commands (RUN_SHELL)
 * - Clipboard (GET_CLIPBOARD, SET_CLIPBOARD)
 * - Notifications (SEND_NOTIFICATION)
 * - Running applications (LIST_APPS)
 *
 * These are reusable across all domains.
 */

import { spawn } from "bun";
import type { LocalTool } from "../core/agent.ts";

// Default allowed paths for file system access
const DEFAULT_ALLOWED_PATHS = ["/Users/guilherme/Projects/"];

/**
 * Get allowed paths from config or use defaults
 */
function getAllowedPaths(): string[] {
  const envPaths = process.env.ALLOWED_PATHS?.split(",").filter(Boolean);
  return envPaths?.length ? envPaths : DEFAULT_ALLOWED_PATHS;
}

/**
 * Check if a path is within allowed directories
 */
function isPathAllowed(path: string): boolean {
  const allowedPaths = getAllowedPaths();
  return allowedPaths.some((allowed) => path.startsWith(allowed));
}

/**
 * Dangerous command patterns to block
 */
const DANGEROUS_PATTERNS = ["rm -rf /", "sudo", "chmod 777", "mkfs", "dd if="];

function isCommandDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((d) => command.includes(d));
}

// ============================================================================
// File System Tools
// ============================================================================

export const LIST_FILES: LocalTool = {
  name: "LIST_FILES",
  description: "List files and folders in a directory. Only works in whitelisted paths.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list" },
      showHidden: { type: "boolean", description: "Include hidden files" },
    },
    required: ["path"],
  },
  execute: async (input) => {
    const { path, showHidden } = input as { path: string; showHidden?: boolean };

    if (!isPathAllowed(path)) {
      return { error: `Path not allowed. Must be under: ${getAllowedPaths().join(", ")}` };
    }

    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(path, { withFileTypes: true });

      const files = entries
        .filter((e) => showHidden || !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({ path, files, count: files.length }) }],
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to list files" };
    }
  },
};

export const READ_FILE: LocalTool = {
  name: "READ_FILE",
  description: "Read a file's contents. Only works in whitelisted paths.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      limit: { type: "number", description: "Maximum lines to read (default: 200)" },
    },
    required: ["path"],
  },
  execute: async (input) => {
    const { path, limit = 200 } = input as { path: string; limit?: number };

    if (!isPathAllowed(path)) {
      return { error: `Path not allowed. Must be under: ${getAllowedPaths().join(", ")}` };
    }

    try {
      const { readFile, stat } = await import("node:fs/promises");
      const stats = await stat(path);

      if (stats.isDirectory()) {
        return { error: "Path is a directory, not a file" };
      }

      const content = await readFile(path, "utf-8");
      const lines = content.split("\n");
      const truncated = lines.length > limit;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path,
              content: lines.slice(0, limit).join("\n"),
              totalLines: lines.length,
              truncated,
              size: stats.size,
            }),
          },
        ],
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to read file" };
    }
  },
};

// ============================================================================
// Shell Tools
// ============================================================================

export const RUN_SHELL: LocalTool = {
  name: "RUN_SHELL",
  description: "Run a shell command. Use with caution - only for simple commands.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      cwd: { type: "string", description: "Working directory (must be within allowed paths)" },
    },
    required: ["command"],
  },
  execute: async (input) => {
    const { command, cwd } = input as { command: string; cwd?: string };
    const defaultCwd = getAllowedPaths()[0] || "/tmp";

    // Validate working directory if specified
    if (cwd && !isPathAllowed(cwd)) {
      return {
        error: `Working directory not allowed. Must be under: ${getAllowedPaths().join(", ")}`,
      };
    }

    // Block dangerous commands
    if (isCommandDangerous(command)) {
      return { error: "Dangerous command blocked" };
    }

    try {
      const proc = spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: cwd || defaultCwd,
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      return {
        stdout: stdout.slice(0, 5000),
        stderr: stderr.slice(0, 1000),
        exitCode,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to run command" };
    }
  },
};

export const LIST_APPS: LocalTool = {
  name: "LIST_APPS",
  description: "List currently running applications on macOS",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    try {
      const proc = spawn(
        [
          "osascript",
          "-e",
          'tell application "System Events" to get name of every process whose background only is false',
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const apps = output.trim().split(", ").filter(Boolean);
      return { apps, count: apps.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to list apps" };
    }
  },
};

// ============================================================================
// Clipboard Tools
// ============================================================================

export const GET_CLIPBOARD: LocalTool = {
  name: "GET_CLIPBOARD",
  description: "Get the current clipboard content (text only)",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    try {
      const proc = spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return { content: output, length: output.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to get clipboard" };
    }
  },
};

export const SET_CLIPBOARD: LocalTool = {
  name: "SET_CLIPBOARD",
  description: "Set the clipboard content",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to copy to clipboard" },
    },
    required: ["text"],
  },
  execute: async (input) => {
    const { text } = input as { text: string };
    try {
      const proc = spawn(["pbcopy"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;

      return { success: true, length: text.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to set clipboard" };
    }
  },
};

// ============================================================================
// Notification Tools
// ============================================================================

export const SEND_NOTIFICATION: LocalTool = {
  name: "SEND_NOTIFICATION",
  description: "Send a macOS notification",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Notification title" },
      message: { type: "string", description: "Notification message" },
      sound: { type: "string", description: "Sound name (e.g., 'Glass', 'Ping', 'Pop')" },
    },
    required: ["title", "message"],
  },
  execute: async (input) => {
    const { title, message, sound } = input as { title: string; message: string; sound?: string };
    try {
      const script = sound
        ? `display notification "${message}" with title "${title}" sound name "${sound}"`
        : `display notification "${message}" with title "${title}"`;

      const proc = spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      return { success: true, title, message };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to send notification" };
    }
  },
};

// ============================================================================
// Export All System Tools
// ============================================================================

export const systemTools: LocalTool[] = [
  LIST_FILES,
  READ_FILE,
  RUN_SHELL,
  LIST_APPS,
  GET_CLIPBOARD,
  SET_CLIPBOARD,
  SEND_NOTIFICATION,
];
