#!/usr/bin/env bun
/**
 * Mesh Bridge CLI - Unified Entry Point
 *
 * Starts the WebSocket server AND provides an interactive CLI.
 * Other clients (browser extensions) connect via WebSocket.
 *
 * Usage:
 *   bun dev                       # Start server + interactive CLI
 *   bun dev --monitor             # Monitor all events from all sources
 *   bun dev --port 9999           # Custom WebSocket port
 *   bun dev --headless            # Server only, no CLI (for background use)
 */

import * as readline from "readline";
import { config, validateConfig } from "../server/config.ts";
import { registerDomain, getAllDomains, getDomain } from "../server/core/domain.ts";
import { checkMeshAvailability, getMeshClient, isMeshReady } from "../server/core/mesh-client.ts";
import { startWebSocketServer, stopWebSocketServer, sessions } from "../server/websocket.ts";
import { whatsappDomain } from "../server/domains/whatsapp/index.ts";
import { cliDomain } from "../server/domains/cli/index.ts";
import type { Session, BridgeFrame } from "../server/core/protocol.ts";
import type { DomainContext } from "../server/core/domain.ts";

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const monitorMode = args.includes("--monitor") || args.includes("-m");
const headlessMode = args.includes("--headless") || args.includes("-H");
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : config.wsPort;

const BRIDGE_VERSION = "0.1.0";

// ============================================================================
// Colors
// ============================================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  bgGreen: "\x1b[42m",
  clearLine: "\x1b[2K\x1b[0G",
};

// ============================================================================
// State
// ============================================================================

let rl: readline.Interface | null = null;
let waitingForResponse = false;
let chatId = `cli-${Date.now()}`;

// Virtual session for CLI (not a WebSocket session)
const cliSession: Session = {
  id: `cli-local-${Date.now()}`,
  client: "mesh-bridge-cli",
  version: BRIDGE_VERSION,
  domain: "cli",
  capabilities: ["text", "monitor"],
  connectedAt: new Date(),
  lastActivity: new Date(),
  conversations: new Map(),
  monitorMode,
};

// ============================================================================
// UI Helpers
// ============================================================================

function printBanner(): void {
  console.log(`
${c.green}╔════════════════════════════════════════════════════════════╗${c.reset}
${c.green}║${c.reset}                                                            ${c.green}║${c.reset}
${c.green}║${c.reset}  ${c.bold}🌐 MESH BRIDGE${c.reset}                                          ${c.green}║${c.reset}
${c.green}║${c.reset}  ${c.dim}Universal Bridge for MCP Mesh${c.reset}                           ${c.green}║${c.reset}
${c.green}║${c.reset}                                                            ${c.green}║${c.reset}
${c.green}╚════════════════════════════════════════════════════════════╝${c.reset}
`);
}

function printHelp(): void {
  console.log(`
${c.cyan}Commands:${c.reset}
  ${c.bold}/help${c.reset}        Show this help
  ${c.bold}/new${c.reset}         Start new conversation thread
  ${c.bold}/monitor${c.reset}     Toggle monitor mode (see all events)
  ${c.bold}/status${c.reset}      Show connection status
  ${c.bold}/clients${c.reset}     List connected clients
  ${c.bold}/quit${c.reset}        Exit

${c.cyan}Tips:${c.reset}
  • Just type a message and press Enter to send to Pilot
  • ${monitorMode ? `${c.green}Monitor mode is ON${c.reset}` : `Use ${c.bold}/monitor${c.reset} to see all events`}
`);
}

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const PROMPT = `${c.green}you ❯${c.reset} `;

function log(prefix: string, color: string, message: string, reprompt = true): void {
  const time = c.dim + formatTime() + c.reset;

  // Clear current line and move cursor to beginning
  process.stdout.write(c.clearLine);

  // Print the log message
  console.log(`${time} ${color}${prefix}${c.reset} ${message}`);

  // Reprint prompt if we're waiting for input
  if (reprompt && rl && !headlessMode) {
    process.stdout.write(PROMPT);
  }
}

function logServer(message: string): void {
  const time = c.dim + formatTime() + c.reset;
  process.stdout.write(c.clearLine);
  console.log(`${time} ${c.magenta}[server]${c.reset} ${message}`);
  if (rl && !headlessMode) {
    process.stdout.write(PROMPT);
  }
}

// ============================================================================
// Domain Context for CLI
// ============================================================================

function createCliContext(): DomainContext {
  return {
    meshClient: getMeshClient(),
    session: cliSession,
    send: (frame: BridgeFrame) => {
      // Handle responses directly in CLI
      switch (frame.type) {
        case "send":
          if (frame.text) {
            log("🤖", c.green, frame.text);
          }
          waitingForResponse = false;
          break;
        case "response":
          if (frame.text && !frame.text.includes("Connected to Mesh Bridge")) {
            log("←", c.cyan, frame.text);
          }
          if (frame.isComplete) {
            waitingForResponse = false;
          }
          break;
        case "agent_progress":
          if (frame.message) {
            log("⚡", c.yellow, `${c.dim}${frame.message}${c.reset}`);
          }
          break;
        case "error":
          log("❌", c.red, frame.message || frame.code || "Unknown error");
          waitingForResponse = false;
          break;
      }
    },
    config: {
      aiPrefix: config.aiPrefix,
    },
  };
}

// ============================================================================
// Client Monitoring
// ============================================================================

function getConnectedClients(): Array<{ id: string; domain: string; since: Date }> {
  const clients: Array<{ id: string; domain: string; since: Date }> = [];

  for (const [, session] of sessions) {
    clients.push({
      id: session.id,
      domain: session.domain,
      since: session.connectedAt,
    });
  }

  return clients;
}

function printClients(): void {
  const clients = getConnectedClients();

  if (clients.length === 0) {
    console.log(`${c.dim}No WebSocket clients connected${c.reset}`);
    return;
  }

  console.log(`\n${c.cyan}Connected clients:${c.reset}`);
  for (const client of clients) {
    const ago = Math.round((Date.now() - client.since.getTime()) / 1000);
    console.log(`  ${c.bold}${client.domain}${c.reset} (${client.id}) - connected ${ago}s ago`);
  }
  console.log();
}

// ============================================================================
// Input Handler
// ============================================================================

async function handleInput(line: string): Promise<boolean> {
  const input = line.trim();
  if (!input) return true;

  // Commands
  if (input.startsWith("/")) {
    const cmd = input.slice(1).toLowerCase();

    switch (cmd) {
      case "help":
      case "h":
        printHelp();
        return true;

      case "new":
      case "n":
        chatId = `cli-${Date.now()}`;
        console.log(`${c.cyan}🧹 Started new thread${c.reset}`);
        return true;

      case "monitor":
      case "m":
        cliSession.monitorMode = !cliSession.monitorMode;
        console.log(
          cliSession.monitorMode
            ? `${c.yellow}👁️ Monitor mode ON - showing all events${c.reset}`
            : `${c.dim}Monitor mode OFF${c.reset}`,
        );
        return true;

      case "status":
      case "s": {
        const meshReady = isMeshReady();
        const clients = getConnectedClients();
        console.log(`\n${c.cyan}Status:${c.reset}`);
        console.log(`  Session: ${cliSession.id}`);
        console.log(`  WebSocket: ws://localhost:${port}`);
        console.log(
          `  Mesh: ${config.mesh.url} ${meshReady ? c.green + "✓" : c.red + "✗"}${c.reset}`,
        );
        console.log(`  Clients: ${clients.length} connected`);
        console.log(`  Monitor: ${cliSession.monitorMode ? "ON" : "OFF"}`);
        console.log();
        return true;
      }

      case "clients":
      case "c":
        printClients();
        return true;

      case "quit":
      case "q":
      case "exit":
        return false;

      default:
        console.log(`${c.yellow}Unknown command: ${cmd}${c.reset}`);
        return true;
    }
  }

  // Regular message - send through domain handler
  const domain = getDomain("cli");
  if (!domain) {
    log("❌", c.red, "CLI domain not registered");
    return true;
  }

  const ctx = createCliContext();
  log("→", c.blue, input, false);
  waitingForResponse = true;

  try {
    await domain.handleMessage(
      {
        id: `msg-${Date.now()}`,
        text: input,
        chatId,
        timestamp: Date.now(),
      },
      ctx,
    );
  } catch (error) {
    log("❌", c.red, error instanceof Error ? error.message : "Unknown error");
    waitingForResponse = false;
  }

  return true;
}

// ============================================================================
// Server Setup
// ============================================================================

async function startServer(): Promise<boolean> {
  validateConfig();

  // Register domains
  registerDomain(whatsappDomain);
  registerDomain(cliDomain);

  // Start WebSocket server
  const server = startWebSocketServer(port);

  if (!server) {
    console.log(`${c.red}Failed to start server - port ${port} in use${c.reset}`);
    console.log(`${c.dim}Another instance may be running${c.reset}`);
    return false;
  }

  const domains = getAllDomains();
  const domainList = domains.map((d) => d.id).join(", ");

  console.log(`${c.green}✓${c.reset} Server started on port ${c.bold}${port}${c.reset}`);
  console.log(`${c.dim}  Domains: ${domainList}${c.reset}`);

  // Check mesh in background
  setTimeout(async () => {
    try {
      const status = await checkMeshAvailability();
      if (status.available) {
        logServer(`Mesh connected ${c.green}✓${c.reset}`);
      }
    } catch {
      logServer(`Mesh not available ${c.dim}(set MESH_API_KEY for standalone)${c.reset}`);
    }
  }, 500);

  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  printBanner();

  // Start the server
  const serverStarted = await startServer();
  if (!serverStarted) {
    process.exit(1);
  }

  // Headless mode - just keep the server running
  if (headlessMode) {
    console.log(`${c.dim}Running in headless mode. Press Ctrl+C to stop.${c.reset}`);
    return; // Server keeps running
  }

  // Interactive mode
  if (monitorMode) {
    console.log(`${c.yellow}👁️ Monitor mode active${c.reset}`);
  }
  printHelp();

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl!.question(PROMPT, async (answer) => {
      const shouldContinue = await handleInput(answer);
      if (shouldContinue) {
        prompt();
      } else {
        rl!.close();
        stopWebSocketServer();
        console.log(`\n${c.dim}Goodbye!${c.reset}`);
        process.exit(0);
      }
    });
  };

  prompt();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
