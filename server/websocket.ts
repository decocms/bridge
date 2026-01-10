/**
 * WebSocket Server for Browser Extensions
 *
 * This is extracted from main.ts to be usable by both:
 * - main.ts (standalone HTTP mode)
 * - stdio.ts (mesh-hosted STDIO mode)
 */

import { config } from "./config.ts";
import {
  type ClientFrame,
  type BridgeFrame,
  type Session,
  createSessionId,
  parseFrame,
  stringifyFrame,
} from "./core/protocol.ts";
import {
  getMeshClient,
  checkMeshAvailability,
  callMeshTool,
  getEventBusBindingId,
  isMeshReady,
} from "./core/mesh-client.ts";
import { type DomainContext, getDomain, getAllDomains, findDomainForUrl } from "./core/domain.ts";
import { EVENT_TYPES, type AgentResponseEvent, type TaskProgressEvent } from "./events.ts";
import { handleAgentResponse, handleAgentProgress } from "./domains/whatsapp/index.ts";
import {
  handleAgentResponse as handleCliResponse,
  handleAgentProgress as handleCliProgress,
} from "./domains/cli/index.ts";

const BRIDGE_VERSION = "0.1.0";

// State
const sessions = new Map<WebSocket, Session>();
let meshStatus: {
  available: boolean;
  hasLLM: boolean;
  tools: string[];
} | null = null;

// Event subscription state
let eventSubscriptionActive = false;

// Server instance for cleanup
let wsServerInstance: ReturnType<typeof Bun.serve> | null = null;
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Reset mesh status cache - call after receiving auth token
 * so next connection/call will re-check availability
 */
export function resetMeshStatus(): void {
  meshStatus = null;
}

/**
 * Subscribe to agent response events for all domains
 */
async function subscribeToEvents(): Promise<void> {
  if (eventSubscriptionActive) return;

  const eventBusId = getEventBusBindingId();
  if (!eventBusId) {
    console.error("[mesh-bridge] EVENT_BUS not configured, skipping subscriptions");
    return;
  }

  // Get our connection ID from env (passed by mesh when spawning STDIO)
  // This is needed because we're subscribing via the gateway, but events
  // should be delivered to our actual connection
  const subscriberId = process.env.MESH_CONNECTION_ID;
  if (!subscriberId) {
    console.error("[mesh-bridge] MESH_CONNECTION_ID not set, subscriptions may not work");
  }

  console.error(
    `[mesh-bridge] Subscribing to events (eventBusId: ${eventBusId}, subscriberId: ${subscriberId || "MISSING!"})`,
  );

  try {
    // Subscribe to agent.response.whatsapp events
    const respResult = await callMeshTool(eventBusId, "EVENT_SUBSCRIBE", {
      eventType: EVENT_TYPES.RESPONSE_WHATSAPP,
      subscriberId, // Use our actual connection ID
    });
    console.error(
      `[mesh-bridge] ✅ Subscribed to ${EVENT_TYPES.RESPONSE_WHATSAPP} → ${JSON.stringify(respResult).slice(0, 100)}`,
    );

    // Subscribe to agent.response.cli events
    const cliRespResult = await callMeshTool(eventBusId, "EVENT_SUBSCRIBE", {
      eventType: EVENT_TYPES.RESPONSE_CLI,
      subscriberId,
    });
    console.error(
      `[mesh-bridge] ✅ Subscribed to ${EVENT_TYPES.RESPONSE_CLI} → ${JSON.stringify(cliRespResult).slice(0, 100)}`,
    );

    // Subscribe to progress events
    const progResult = await callMeshTool(eventBusId, "EVENT_SUBSCRIBE", {
      eventType: EVENT_TYPES.TASK_PROGRESS,
      subscriberId,
    });
    console.error(
      `[mesh-bridge] ✅ Subscribed to ${EVENT_TYPES.TASK_PROGRESS} → ${JSON.stringify(progResult).slice(0, 100)}`,
    );

    // Subscribe to task completion events (for async workflows)
    const completeResult = await callMeshTool(eventBusId, "EVENT_SUBSCRIBE", {
      eventType: EVENT_TYPES.TASK_COMPLETED,
      subscriberId,
    });
    console.error(
      `[mesh-bridge] ✅ Subscribed to ${EVENT_TYPES.TASK_COMPLETED} → ${JSON.stringify(completeResult).slice(0, 100)}`,
    );

    eventSubscriptionActive = true;
  } catch (error) {
    console.error("[mesh-bridge] ❌ Failed to subscribe to events:", error);
  }
}

/**
 * Handle incoming events from the mesh (called via ON_EVENTS tool)
 */
export async function handleIncomingEvents(
  events: Array<{ id: string; type: string; source: string; data: unknown }>,
): Promise<Record<string, { success: boolean; error?: string }>> {
  const results: Record<string, { success: boolean; error?: string }> = {};

  console.error(`[mesh-bridge] handleIncomingEvents called with ${events.length} events`);

  for (const event of events) {
    console.error(`[mesh-bridge] → Processing event: ${event.type} (id: ${event.id})`);

    try {
      // Find active sessions for this event type
      const activeSessions = Array.from(sessions.entries());

      console.error(
        `[mesh-bridge]   Active sessions: ${activeSessions.length}, domains: [${activeSessions.map(([, s]) => s.domain).join(", ")}]`,
      );

      if (activeSessions.length === 0) {
        console.error(`[mesh-bridge]   ⚠️ No active WebSocket sessions to receive event`);
        results[event.id] = { success: true }; // Still success - event was received
        continue;
      }

      for (const [ws, session] of activeSessions) {
        const ctx = createDomainContext(ws, session);

        if (event.type === EVENT_TYPES.RESPONSE_WHATSAPP && session.domain === "whatsapp") {
          console.error(`[mesh-bridge]   ✅ Routing RESPONSE to WhatsApp session ${session.id}`);
          console.error(
            `[mesh-bridge]   Response data: ${JSON.stringify(event.data).slice(0, 200)}`,
          );
          await handleAgentResponse(event.data as AgentResponseEvent, ctx);
          console.error(`[mesh-bridge]   ✅ Response handler completed`);
        } else if (event.type === EVENT_TYPES.RESPONSE_CLI && session.domain === "cli") {
          console.error(`[mesh-bridge]   ✅ Routing RESPONSE to CLI session ${session.id}`);
          await handleCliResponse(event.data as AgentResponseEvent, ctx);
        } else if (event.type === EVENT_TYPES.TASK_COMPLETED && session.domain === "whatsapp") {
          // Handle async workflow completion - ONLY if source is whatsapp
          const taskData = event.data as {
            taskId: string;
            workflowId?: string;
            workflowTitle?: string;
            status: string;
            result?: string;
            error?: string;
            chatId?: string;
            source?: string;
          };

          // CRITICAL: Only handle events that were sent FROM whatsapp
          // Otherwise CLI/other sources get routed here incorrectly!
          if (taskData.source !== "whatsapp") {
            console.error(
              `[mesh-bridge]   ⏭️ Skipping TASK_COMPLETED - source is "${taskData.source}", not "whatsapp"`,
            );
            continue;
          }

          // Handle task completion - send result to user
          console.error(
            `[mesh-bridge]   ✅ Task completed: ${taskData.taskId} (status: ${taskData.status})`,
          );

          if (taskData.status === "completed" && taskData.result) {
            // Send the result as a response
            const resultText =
              typeof taskData.result === "string"
                ? taskData.result
                : JSON.stringify(taskData.result);

            ctx.send({
              type: "send",
              id: `task-${taskData.taskId}`,
              text: `🤖 ${resultText}`,
            });
          } else if (taskData.status === "failed") {
            ctx.send({
              type: "agent_progress",
              message: `❌ ${taskData.workflowTitle || "Task"} failed: ${taskData.error || "Unknown error"}`,
            });
          }
        } else if (event.type === EVENT_TYPES.TASK_PROGRESS) {
          const progressData = event.data as TaskProgressEvent;
          // Route progress to matching domain OR monitor mode sessions
          if (progressData.source === session.domain) {
            if (session.domain === "cli") {
              await handleCliProgress(progressData, ctx);
            } else if (session.domain === "whatsapp") {
              await handleAgentProgress(progressData, ctx);
            }
          } else if (session.domain === "cli" && session.monitorMode) {
            // CLI in monitor mode sees ALL progress
            await handleCliProgress(progressData, ctx);
          } else {
            console.error(
              `[mesh-bridge]   ⏭️ Skipping progress - source "${progressData.source}" != domain "${session.domain}"`,
            );
          }
        } else {
          console.error(
            `[mesh-bridge]   ⏭️ Event ${event.type} not handled for session domain ${session.domain}`,
          );
        }
      }

      results[event.id] = { success: true };
    } catch (error) {
      console.error(`[mesh-bridge]   ❌ Error handling event ${event.type}:`, error);
      results[event.id] = {
        success: false,
        error: error instanceof Error ? error.message : "Failed to handle event",
      };
    }
  }

  console.error(`[mesh-bridge] handleIncomingEvents done, results: ${Object.keys(results).length}`);
  return results;
}

// Idempotency cache
const processedRequests = new Map<string, { result: unknown; timestamp: number }>();
const IDEMPOTENCY_TTL = 5 * 60 * 1000;

// ============================================================================
// Helpers
// ============================================================================

function send(ws: WebSocket, frame: BridgeFrame): void {
  if (frame.type === "send") {
    console.error(
      `[mesh-bridge] 📤 Sending "send" frame to WebSocket: ${JSON.stringify(frame).slice(0, 150)}`,
    );
  }
  ws.send(stringifyFrame(frame));
}

function getSession(ws: WebSocket): Session | undefined {
  return sessions.get(ws);
}

function createDomainContext(ws: WebSocket, session: Session): DomainContext {
  return {
    meshClient: getMeshClient(),
    session,
    send: (frame) => send(ws, frame),
    config: {
      aiPrefix: config.aiPrefix,
    },
  };
}

function cleanupIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, value] of processedRequests) {
    if (now - value.timestamp > IDEMPOTENCY_TTL) {
      processedRequests.delete(key);
    }
  }
}

// ============================================================================
// Frame Handlers
// ============================================================================

async function handleConnect(
  ws: WebSocket,
  frame: ClientFrame & { type: "connect" },
): Promise<void> {
  // Find domain for this connection
  let domain = getDomain(frame.domain);

  // If no explicit domain, try to match by URL
  if (!domain && frame.url) {
    domain = findDomainForUrl(frame.url);
  }

  // Default to first available domain if none matched
  if (!domain) {
    const allDomains = getAllDomains();
    domain = allDomains[0];
  }

  const domainId = domain?.id || "unknown";

  // Create session
  const session: Session = {
    id: createSessionId(),
    client: frame.client,
    version: frame.version,
    domain: domainId,
    url: frame.url,
    capabilities: frame.capabilities || [],
    connectedAt: new Date(),
    lastActivity: new Date(),
    conversations: new Map(),
  };

  sessions.set(ws, session);

  // Get mesh status lazily - but only if we have a token
  // In STDIO mode, we wait for ON_MCP_CONFIGURATION to get the token
  if (!meshStatus) {
    try {
      meshStatus = await checkMeshAvailability();
    } catch (error) {
      // If auth error, credentials are stale - send error and exit
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes("Auth error") || errMsg.includes("401") || errMsg.includes("403")) {
        send(ws, {
          type: "error",
          id: "connect",
          code: "credentials_stale",
          message: "Bridge has stale credentials. Restarting...",
        });
        console.error("[mesh-bridge] Stale credentials detected on connect. Exiting...");
        setTimeout(() => process.exit(1), 100);
        return;
      }
      // This is expected on first connection before ON_MCP_CONFIGURATION is called
      meshStatus = { available: false, hasLLM: false, tools: [] };
    }
  }

  // Notify domain
  if (domain?.onConnect) {
    const ctx = createDomainContext(ws, session);
    await domain.onConnect(ctx);
  }

  // Send connected response
  const connectedFrame = {
    type: "connected" as const,
    sessionId: session.id,
    bridgeVersion: BRIDGE_VERSION,
    domain: domainId,
    mesh: {
      available: meshStatus?.available ?? false,
      hasLLM: meshStatus?.hasLLM ?? false,
      tools: meshStatus?.tools ?? [],
    },
    domains: getAllDomains().map((d) => ({ id: d.id, name: d.name })),
  };
  console.error(`[mesh-bridge] Sending connected frame to ${session.id}`);
  send(ws, connectedFrame);

  // Debug: Log detailed state when browser extension connects
  const eventBusId = getEventBusBindingId();
  console.error(`[mesh-bridge] Session started: ${session.id} (${domainId}) PID: ${process.pid}`);
  console.error(
    `[mesh-bridge] Connection state - eventBusId: ${eventBusId ?? "NOT SET"}, meshReady: ${isMeshReady()}`,
  );

  // Subscribe to events (once per bridge instance)
  subscribeToEvents().catch(console.error);
}

async function handlePing(ws: WebSocket, frame: ClientFrame & { type: "ping" }): Promise<void> {
  const session = getSession(ws);
  if (session) {
    session.lastActivity = new Date();
  }

  send(ws, {
    type: "pong",
    id: frame.id,
    timestamp: Date.now(),
  });
}

async function handleCommand(
  ws: WebSocket,
  frame: ClientFrame & { type: "command" },
): Promise<void> {
  const session = getSession(ws);
  if (!session) {
    send(ws, { type: "error", id: frame.id, code: "NO_SESSION", message: "Not connected" });
    return;
  }

  session.lastActivity = new Date();

  // Route to domain
  const domain = getDomain(frame.domain || session.domain);
  if (!domain) {
    send(ws, {
      type: "error",
      id: frame.id,
      code: "NO_DOMAIN",
      message: `Unknown domain: ${frame.domain || session.domain}`,
    });
    return;
  }

  if (domain.handleCommand) {
    const ctx = createDomainContext(ws, session);
    await domain.handleCommand({ id: frame.id, command: frame.command, args: frame.args }, ctx);
  } else {
    send(ws, {
      type: "error",
      id: frame.id,
      code: "NO_HANDLER",
      message: `Domain ${domain.id} doesn't handle commands`,
    });
  }
}

async function handleMessage(
  ws: WebSocket,
  frame: ClientFrame & { type: "message" },
): Promise<void> {
  const session = getSession(ws);
  if (!session) {
    send(ws, { type: "error", id: frame.id, code: "NO_SESSION", message: "Not connected" });
    return;
  }

  session.lastActivity = new Date();

  // Check idempotency
  if (processedRequests.has(frame.id)) {
    const cached = processedRequests.get(frame.id)!;
    send(ws, {
      type: "response",
      id: frame.id,
      text: "(cached response)",
      isComplete: true,
    });
    return;
  }

  // Route to domain handler
  const domain = getDomain(frame.domain || session.domain);
  if (!domain) {
    send(ws, {
      type: "error",
      id: frame.id,
      code: "NO_DOMAIN",
      message: `Unknown domain: ${frame.domain || session.domain}`,
    });
    return;
  }

  const ctx = createDomainContext(ws, session);

  try {
    await domain.handleMessage(
      {
        id: frame.id,
        text: frame.text,
        chatId: frame.chatId,
        isSelf: frame.isSelf,
        timestamp: frame.timestamp,
        metadata: frame.metadata,
      },
      ctx,
    );

    // Cache for idempotency
    processedRequests.set(frame.id, {
      result: { type: "response", id: frame.id, text: "processed", isComplete: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[mesh-bridge] Domain error:`, error);
    send(ws, {
      type: "error",
      id: frame.id,
      code: "DOMAIN_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleToolCall(
  ws: WebSocket,
  frame: ClientFrame & { type: "tool_call" },
): Promise<void> {
  const session = getSession(ws);
  if (!session) {
    send(ws, { type: "error", id: frame.id, code: "NO_SESSION", message: "Not connected" });
    return;
  }

  session.lastActivity = new Date();

  try {
    const meshClient = getMeshClient();
    const result = await meshClient.callTool(frame.tool, frame.arguments);

    send(ws, {
      type: "tool_result",
      id: frame.id,
      result,
      success: true,
    });
  } catch (error) {
    send(ws, {
      type: "tool_result",
      id: frame.id,
      result: { error: error instanceof Error ? error.message : "Unknown error" },
      success: false,
    });
  }
}

async function handleEvent(ws: WebSocket, frame: ClientFrame & { type: "event" }): Promise<void> {
  const session = getSession(ws);
  if (!session) return;

  session.lastActivity = new Date();

  console.error(`[mesh-bridge] Event from ${session.domain}:`, frame.event, frame.data);
}

// ============================================================================
// Server Cleanup
// ============================================================================

/**
 * Stop the WebSocket server and clean up resources
 */
export function stopWebSocketServer(): void {
  console.error(`[mesh-bridge] stopWebSocketServer called (pid: ${process.pid})`);

  if (wsServerInstance) {
    console.error("[mesh-bridge] Stopping WebSocket server...");
    try {
      wsServerInstance.stop(true); // true = close all connections immediately
    } catch (e) {
      console.error("[mesh-bridge] Error stopping server:", e);
    }
    wsServerInstance = null;
  }

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clear all sessions
  const sessionCount = sessions.size;
  sessions.clear();
  eventSubscriptionActive = false;

  console.error(`[mesh-bridge] WebSocket server stopped (cleared ${sessionCount} sessions)`);
}

// Register cleanup handlers for graceful shutdown
function registerCleanupHandlers(): void {
  const cleanup = () => {
    stopWebSocketServer();
    process.exit(0);
  };

  // Handle various termination signals
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("[mesh-bridge] Uncaught exception:", error);
    stopWebSocketServer();
    process.exit(1);
  });

  // Bun hot reload - clean up before reload
  if (typeof Bun !== "undefined" && "hot" in Bun) {
    // @ts-ignore - Bun.hot is experimental
    Bun.hot?.dispose?.(() => {
      console.error("[mesh-bridge] Hot reload - cleaning up...");
      stopWebSocketServer();
    });
  }
}

// ============================================================================
// Port Cleanup
// ============================================================================

/**
 * Kill any existing process using the specified port.
 * This handles zombie processes from previous runs.
 */
async function killProcessOnPort(port: number): Promise<void> {
  try {
    // Find process using the port (macOS/Linux)
    const lsof = Bun.spawn(["lsof", "-ti", `:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(lsof.stdout).text();
    const pids = output.trim().split("\n").filter(Boolean);

    if (pids.length > 0) {
      console.error(
        `[mesh-bridge] Found ${pids.length} process(es) on port ${port}: ${pids.join(", ")}`,
      );

      for (const pid of pids) {
        const pidNum = parseInt(pid, 10);
        if (pidNum && pidNum !== process.pid) {
          console.error(`[mesh-bridge] Killing process ${pidNum}...`);
          try {
            process.kill(pidNum, "SIGTERM");
            // Give it a moment to die
            await new Promise((resolve) => setTimeout(resolve, 100));
            // Force kill if still alive
            try {
              process.kill(pidNum, 0); // Check if still alive
              process.kill(pidNum, "SIGKILL");
            } catch {
              // Process is dead, good
            }
          } catch (e) {
            // Process might already be dead
            console.error(`[mesh-bridge] Could not kill ${pidNum}: ${e}`);
          }
        }
      }

      // Wait a bit for the port to be released
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch {
    // lsof not available or no processes found
  }
}

// ============================================================================
// Server
// ============================================================================

export async function startWebSocketServer(
  port: number,
): Promise<ReturnType<typeof Bun.serve> | null> {
  // Clean up any existing server first (in case of hot reload)
  if (wsServerInstance) {
    console.error("[mesh-bridge] Cleaning up existing server before restart...");
    stopWebSocketServer();
  }

  // Kill any zombie processes from previous runs
  await killProcessOnPort(port);

  // Start idempotency cache cleanup
  cleanupIntervalId = setInterval(cleanupIdempotencyCache, 60 * 1000);

  // Register cleanup handlers (only once)
  registerCleanupHandlers();

  try {
    const server = Bun.serve({
      port,
      reusePort: true, // Allow port reuse for faster restarts
      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }

        // Health + status endpoint
        return new Response(
          JSON.stringify({
            name: "mesh-bridge",
            version: BRIDGE_VERSION,
            status: "ok",
            mesh: {
              url: config.mesh.url,
              available: meshStatus?.available ?? false,
              tools: meshStatus?.tools.length ?? 0,
            },
            domains: getAllDomains().map((d) => ({ id: d.id, name: d.name })),
            sessions: sessions.size,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      websocket: {
        open(ws) {
          console.error(`[mesh-bridge] WebSocket opened`);
        },
        message(ws, data) {
          const frame = parseFrame(String(data));
          if (!frame) {
            send(ws, {
              type: "error",
              id: "parse",
              code: "INVALID_FRAME",
              message: "Invalid JSON",
            });
            return;
          }

          // Route frame to handler
          switch (frame.type) {
            case "connect":
              handleConnect(ws, frame).catch(console.error);
              break;
            case "ping":
              handlePing(ws, frame).catch(console.error);
              break;
            case "command":
              handleCommand(ws, frame).catch(console.error);
              break;
            case "message":
              handleMessage(ws, frame).catch(console.error);
              break;
            case "tool_call":
              handleToolCall(ws, frame).catch(console.error);
              break;
            case "event":
              handleEvent(ws, frame).catch(console.error);
              break;
            default:
              send(ws, {
                type: "error",
                id: "unknown",
                code: "UNKNOWN_FRAME",
                message: "Unknown frame type",
              });
          }
        },
        close(ws) {
          const session = sessions.get(ws);
          if (session) {
            // Clean up domain
            const domain = getDomain(session.domain);
            if (domain?.onDestroy) {
              const ctx = createDomainContext(ws, session);
              domain.onDestroy(ctx).catch(console.error);
            }

            console.error(`[mesh-bridge] Session ended: ${session.id} (${session.domain})`);
            sessions.delete(ws);
          }
        },
      },
    });

    wsServerInstance = server;
    console.error(`[mesh-bridge] WebSocket server started on port ${port} (pid: ${process.pid})`);
    return server;
  } catch (error) {
    // Port already in use - another instance is running
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      console.error(`[mesh-bridge] Port ${port} already in use (another instance running)`);
      console.error(`[mesh-bridge] Running in tool-fetch mode (WS server on another instance)`);
      return null;
    }
    throw error;
  }
}

export { sessions, meshStatus };
