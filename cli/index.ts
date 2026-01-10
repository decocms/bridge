#!/usr/bin/env bun
/**
 * Mesh Bridge CLI
 *
 * Terminal client for the Mesh Bridge.
 * Connects to the WebSocket server (started by `bun stdio`).
 *
 * Usage:
 *   bun dev                       # Connect with default settings
 *   bun dev --monitor             # Monitor all events from all sources
 *   bun dev --host localhost      # Custom host
 *   bun dev --port 9999           # Custom port
 */

import * as readline from "readline";

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const monitorMode = args.includes("--monitor") || args.includes("-m");
const hostIdx = args.indexOf("--host");
const portIdx = args.indexOf("--port");
const host = hostIdx >= 0 ? args[hostIdx + 1] : "localhost";
const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 9999;

const WS_URL = `ws://${host}:${port}`;
const CLIENT_VERSION = "1.0.0";

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

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let isConnected = false;
let chatId = `cli-${Date.now()}`;
let rl: readline.Interface | null = null;
let waitingForResponse = false;

// ============================================================================
// UI Helpers
// ============================================================================

function printBanner(): void {
  console.log(`
${c.green}╔════════════════════════════════════════════════════════════╗${c.reset}
${c.green}║${c.reset}                                                            ${c.green}║${c.reset}
${c.green}║${c.reset}  ${c.bold}🌐 MESH BRIDGE CLI${c.reset}                                      ${c.green}║${c.reset}
${c.green}║${c.reset}  ${c.dim}Terminal Interface for Mesh Bridge${c.reset}                      ${c.green}║${c.reset}
${c.green}║${c.reset}                                                            ${c.green}║${c.reset}
${c.green}╚════════════════════════════════════════════════════════════╝${c.reset}
`);
}

function printHelp(): void {
  console.log(`
${c.cyan}Commands:${c.reset}
  ${c.bold}/help${c.reset}      Show this help
  ${c.bold}/new${c.reset}       Start new thread
  ${c.bold}/monitor${c.reset}   Toggle monitor mode (see all events)
  ${c.bold}/status${c.reset}    Show connection status
  ${c.bold}/quit${c.reset}      Exit CLI

${c.cyan}Tips:${c.reset}
  • Just type a message and press Enter to send to Pilot
  • ${monitorMode ? `${c.green}Monitor mode is ON${c.reset}` : `Run with ${c.bold}--monitor${c.reset} to see all events`}
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
  if (reprompt && rl) {
    process.stdout.write(PROMPT);
  }
}

// ============================================================================
// WebSocket Client
// ============================================================================

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`${c.dim}Connecting to ${WS_URL}...${c.reset}`);

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      // Send connect frame
      ws!.send(
        JSON.stringify({
          type: "connect",
          client: "mesh-bridge-cli",
          version: CLIENT_VERSION,
          domain: "cli",
          capabilities: ["text", "monitor"],
        }),
      );
    };

    ws.onmessage = (event) => {
      handleFrame(JSON.parse(event.data));
      if (!isConnected) {
        isConnected = true;
        resolve();
      }
    };

    ws.onerror = (error) => {
      console.error(`${c.red}WebSocket error:${c.reset}`, error);
      if (!isConnected) {
        reject(error);
      }
    };

    ws.onclose = () => {
      if (isConnected) {
        console.log(`\n${c.yellow}Disconnected from bridge${c.reset}`);
        process.exit(0);
      }
    };
  });
}

function handleFrame(frame: Record<string, unknown>): void {
  switch (frame.type) {
    case "connected":
      sessionId = frame.sessionId as string;
      const domains = (frame.domains as Array<{ id: string; name: string }>) || [];
      console.log(`${c.green}✓ Connected${c.reset} (session: ${sessionId})`);
      console.log(`${c.dim}Domains: ${domains.map((d) => d.id).join(", ")}${c.reset}`);
      if (monitorMode) {
        console.log(`${c.yellow}👁️ Monitor mode active - showing all events${c.reset}`);
        sendCommand("monitor");
      }
      printHelp();
      break;

    case "response": {
      const text = (frame.text as string) || "";
      if (text && !text.includes("Connected to Mesh Bridge")) {
        // Display response with "pilot >" prefix in magenta
        // Clear line first to avoid overlapping with readline prompt
        process.stdout.write(c.clearLine);
        const timestamp = formatTime();
        console.log(
          `${c.dim}${timestamp}${c.reset} ${c.magenta}${c.bold}pilot ❯${c.reset} ${text}`,
        );
        waitingForResponse = false;
        // Reprint the prompt
        if (rl) rl.prompt();
      }
      break;
    }

    case "agent_progress": {
      const progressMsg = (frame.message as string) || "";
      log("⚡", c.yellow, `${c.dim}${progressMsg}${c.reset}`);
      break;
    }

    case "send": {
      // Response from agent (final response via send frame)
      const sendText = (frame.text as string) || "";
      log("🤖", c.green, sendText);
      waitingForResponse = false;
      break;
    }

    case "error": {
      const errMsg = (frame.message as string) || (frame.code as string) || "Unknown error";
      log("❌", c.red, errMsg);
      waitingForResponse = false;
      break;
    }

    case "pong":
      // Ignore pong
      break;

    default:
      // Log unknown frames for debugging
      if (monitorMode) {
        log("📩", c.magenta, `${c.dim}${JSON.stringify(frame)}${c.reset}`);
      }
  }
}

function send(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log(`${c.red}Not connected${c.reset}`);
    return;
  }

  ws.send(
    JSON.stringify({
      type: "message",
      id: `msg-${Date.now()}`,
      domain: "cli",
      text,
      chatId,
      timestamp: Date.now(),
    }),
  );

  log("→", c.blue, text, false); // Don't reprompt, we'll do it after
  waitingForResponse = true;
}

function sendCommand(command: string, args?: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log(`${c.red}Not connected${c.reset}`);
    return;
  }

  ws.send(
    JSON.stringify({
      type: "command",
      id: `cmd-${Date.now()}`,
      domain: "cli",
      command,
      args,
    }),
  );
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
        sendCommand("new_thread");
        console.log(`${c.cyan}🧹 Started new thread${c.reset}`);
        return true;

      case "monitor":
      case "m":
        sendCommand("monitor");
        return true;

      case "status":
      case "s":
        console.log(`${c.cyan}Session:${c.reset} ${sessionId}`);
        console.log(`${c.cyan}Chat ID:${c.reset} ${chatId}`);
        console.log(`${c.cyan}Bridge:${c.reset} ${WS_URL}`);
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

  // Regular message
  send(input);
  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  printBanner();

  try {
    await connect();
  } catch (error) {
    console.error(`${c.red}Failed to connect to ${WS_URL}${c.reset}`);
    console.error(`${c.dim}Make sure the bridge server is running (bun stdio)${c.reset}`);
    process.exit(1);
  }

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
        ws?.close();
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
