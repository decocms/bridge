#!/usr/bin/env bun
/**
 * Mesh Bridge CLI
 *
 * Terminal client for the Mesh Bridge.
 * Connects to the WebSocket server (started by `bun stdio`).
 * Auto-reconnects on connection loss.
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

// Reconnection settings
const RECONNECT_INITIAL_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds
const RECONNECT_BACKOFF = 1.5; // Exponential backoff multiplier

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
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

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
  ${c.bold}/reconnect${c.reset} Force reconnection
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

function statusLog(message: string): void {
  process.stdout.write(c.clearLine);
  console.log(`${c.dim}${formatTime()}${c.reset} ${c.yellow}⚡${c.reset} ${message}`);
  if (rl && isConnected) {
    process.stdout.write(PROMPT);
  }
}

// ============================================================================
// WebSocket Client with Reconnection
// ============================================================================

function getReconnectDelay(): number {
  const delay = Math.min(
    RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_BACKOFF, reconnectAttempts),
    RECONNECT_MAX_DELAY
  );
  return delay;
}

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  const delay = getReconnectDelay();
  reconnectAttempts++;
  
  statusLog(`${c.dim}Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...${c.reset}`);
  
  reconnectTimeout = setTimeout(() => {
    connect().catch(() => {
      // Connection failed, will trigger another reconnect via onclose/onerror
    });
  }, delay);
}

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isShuttingDown) {
      reject(new Error("Shutting down"));
      return;
    }
    
    // Clean up existing connection
    if (ws) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
      ws = null;
    }
    
    if (reconnectAttempts === 0) {
      console.log(`${c.dim}Connecting to ${WS_URL}...${c.reset}`);
    }

    ws = new WebSocket(WS_URL);
    let connectionResolved = false;

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
      if (!connectionResolved) {
        connectionResolved = true;
        isConnected = true;
        reconnectAttempts = 0; // Reset on successful connection
        resolve();
      }
    };

    ws.onerror = () => {
      // Don't log every error during reconnection attempts
      if (reconnectAttempts === 0) {
        statusLog(`${c.red}Connection error${c.reset}`);
      }
      
      if (!connectionResolved) {
        connectionResolved = true;
        reject(new Error("Connection failed"));
      }
    };

    ws.onclose = () => {
      const wasConnected = isConnected;
      isConnected = false;
      
      if (!connectionResolved) {
        connectionResolved = true;
        reject(new Error("Connection closed"));
        return;
      }
      
      if (isShuttingDown) {
        return;
      }
      
      if (wasConnected) {
        statusLog(`${c.yellow}Disconnected from bridge${c.reset}`);
      }
      
      // Schedule reconnection
      scheduleReconnect();
    };
  });
}

function handleFrame(frame: Record<string, unknown>): void {
  switch (frame.type) {
    case "connected":
      sessionId = frame.sessionId as string;
      const domains = (frame.domains as Array<{ id: string; name: string }>) || [];
      const mesh = frame.mesh as {
        available?: boolean;
        hasLLM?: boolean;
        tools?: string[];
        agent?: {
          id: string;
          title: string;
          tools: Array<{ name: string; description?: string }>;
        } | null;
      } | undefined;
      
      if (reconnectAttempts === 0) {
        // First connection
        console.log(`${c.green}✓ Connected${c.reset} (session: ${sessionId})`);
        console.log(`${c.dim}Domains: ${domains.map((d) => d.id).join(", ")}${c.reset}`);
        
        // Agent info will arrive asynchronously via agent_info frame
        // No need to show warning here since it arrives shortly after connection
        
        if (monitorMode) {
          console.log(`${c.yellow}👁️ Monitor mode active - showing all events${c.reset}`);
          sendCommand("monitor");
        }
        printHelp();
      } else {
        // Reconnection
        statusLog(`${c.green}Reconnected${c.reset} (session: ${sessionId})`);
        if (monitorMode) {
          sendCommand("monitor");
        }
      }
      break;

    case "response": {
      const text = (frame.text as string) || "";
      if (text && !text.includes("Connected to Mesh Bridge")) {
        log("←", c.cyan, text);
        waitingForResponse = false;
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

    case "agent_info": {
      // #region debug log
      fetch('http://127.0.0.1:7242/ingest/8397b2ea-9df9-487e-9ffa-b17eb1bfd701',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'cli/index.ts:341',message:'Received agent_info frame',data:{hasAgent:!!frame.agent},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion

      const agent = frame.agent as {
        id: string;
        title: string;
        tools: Array<{ name: string; description?: string }>;
      };
      const toolCount = agent.tools.length;
      
      // Clear current line and print agent info (multi-line output)
      process.stdout.write(c.clearLine);
      console.log(`\n${c.cyan}🤖 Agent Gateway: ${c.bold}${agent.title}${c.reset} ${c.dim}(${agent.id.slice(0, 12)}...)${c.reset}`);
      console.log(`${c.dim}   ${toolCount} tool${toolCount !== 1 ? "s" : ""} available${c.reset}`);
      
      if (agent.tools.length > 0) {
        // Show first 8 tools
        const toolsToShow = agent.tools.slice(0, 8);
        for (const tool of toolsToShow) {
          const desc = tool.description ? ` ${c.dim}- ${tool.description.slice(0, 60)}${tool.description.length > 60 ? "..." : ""}${c.reset}` : "";
          console.log(`   ${c.gray}•${c.reset} ${c.yellow}${tool.name}${c.reset}${desc}`);
        }
        if (agent.tools.length > 8) {
          console.log(`   ${c.dim}... and ${agent.tools.length - 8} more${c.reset}`);
        }
      }
      console.log(); // Empty line for spacing
      
      // Reprint prompt if readline is active
      if (rl && isConnected) {
        process.stdout.write(PROMPT);
      }
      break;
    }

    default:
      // Log unknown frames for debugging
      if (monitorMode) {
        log("📩", c.magenta, `${c.dim}${JSON.stringify(frame)}${c.reset}`);
      }
  }
}

function send(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log(`${c.red}Not connected${c.reset} ${c.dim}(waiting for reconnection...)${c.reset}`);
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
        console.log(`${c.cyan}Session:${c.reset} ${sessionId || "(not connected)"}`);
        console.log(`${c.cyan}Chat ID:${c.reset} ${chatId}`);
        console.log(`${c.cyan}Bridge:${c.reset} ${WS_URL}`);
        console.log(`${c.cyan}Connected:${c.reset} ${isConnected ? c.green + "yes" : c.red + "no"}${c.reset}`);
        if (!isConnected && reconnectAttempts > 0) {
          console.log(`${c.cyan}Reconnect attempts:${c.reset} ${reconnectAttempts}`);
        }
        return true;

      case "reconnect":
      case "r":
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        reconnectAttempts = 0;
        console.log(`${c.cyan}Forcing reconnection...${c.reset}`);
        connect().catch(() => {
          // Will auto-retry
        });
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

  // Set up readline first so we can show prompts during reconnection
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Handle Ctrl+C gracefully
  rl.on("close", () => {
    isShuttingDown = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    ws?.close();
    console.log(`\n${c.dim}Goodbye!${c.reset}`);
    process.exit(0);
  });

  // Start connection (will auto-retry on failure)
  try {
    await connect();
  } catch {
    // First connection failed, but we'll keep trying
    statusLog(`${c.dim}Waiting for bridge server...${c.reset}`);
  }

  const prompt = () => {
    rl!.question(PROMPT, async (answer) => {
      const shouldContinue = await handleInput(answer);
      if (shouldContinue) {
        prompt();
      } else {
        isShuttingDown = true;
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        rl!.close();
        ws?.close();
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
