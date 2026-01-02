/**
 * Safe terminal command execution with path whitelisting
 */

import { config } from "./config.ts";
import { spawn } from "node:child_process";
import { resolve, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/**
 * Check if a path is within the allowed directories
 */
export function isPathAllowed(targetPath: string): boolean {
  const normalizedTarget = normalize(resolve(targetPath));

  for (const allowedPath of config.terminal.allowedPaths) {
    const normalizedAllowed = normalize(resolve(allowedPath));
    if (normalizedTarget.startsWith(normalizedAllowed)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a command contains blocked patterns
 */
export function isCommandBlocked(command: string): boolean {
  const lowerCommand = command.toLowerCase();
  return config.terminal.blockedCommands.some((blocked) =>
    lowerCommand.includes(blocked.toLowerCase()),
  );
}

/**
 * Execute a command in a specific directory
 */
export async function executeCommand(command: string, cwd: string): Promise<CommandResult> {
  // Validate the working directory
  if (!isPathAllowed(cwd)) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: `Directory not allowed: ${cwd}. Allowed paths: ${config.terminal.allowedPaths.join(", ")}`,
    };
  }

  // Check if directory exists
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: `Directory does not exist: ${cwd}`,
    };
  }

  // Check for blocked commands
  if (isCommandBlocked(command)) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: `Command contains blocked pattern. Blocked: ${config.terminal.blockedCommands.join(", ")}`,
    };
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        stdout,
        stderr,
        exitCode: 124,
        error: `Command timed out after ${config.terminal.timeout / 1000} seconds`,
      });
    }, config.terminal.timeout);

    let stdout = "";
    let stderr = "";

    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
    });

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        stdout,
        stderr,
        exitCode: 1,
        error: err.message,
      });
    });
  });
}

/**
 * List files in a directory (safe)
 */
export async function listDirectory(path: string): Promise<CommandResult> {
  return executeCommand("ls -la", path);
}

/**
 * Read a file (with path validation)
 */
export async function readFile(filePath: string): Promise<string> {
  if (!isPathAllowed(filePath)) {
    throw new Error(
      `File not in allowed paths: ${filePath}. Allowed: ${config.terminal.allowedPaths.join(", ")}`,
    );
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  return file.text();
}

/**
 * Write to a file (with path validation)
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  if (!isPathAllowed(filePath)) {
    throw new Error(
      `File not in allowed paths: ${filePath}. Allowed: ${config.terminal.allowedPaths.join(", ")}`,
    );
  }

  await Bun.write(filePath, content);
}
