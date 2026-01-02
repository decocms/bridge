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
import { getMeshClient, checkMeshAvailability } from "./core/mesh-client.ts";
import { type DomainContext, getDomain, getAllDomains, findDomainForUrl } from "./core/domain.ts";

const BRIDGE_VERSION = "0.1.0";

// State
const sessions = new Map<WebSocket, Session>();
let meshStatus: {
  available: boolean;
  hasLLM: boolean;
  tools: string[];
} | null = null;

/**
 * Reset mesh status cache - call after receiving auth token
 * so next connection/call will re-check availability
 */
export function resetMeshStatus(): void {
  meshStatus = null;
}

// Idempotency cache
const processedRequests = new Map<string, { result: unknown; timestamp: number }>();
const IDEMPOTENCY_TTL = 5 * 60 * 1000;

// ============================================================================
// Helpers
// ============================================================================

function send(ws: WebSocket, frame: BridgeFrame): void {
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
      defaultModel: config.mesh.defaultModel,
      fastModel: config.mesh.fastModel,
      smartModel: config.mesh.smartModel,
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
    } catch {
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
  send(ws, {
    type: "connected",
    sessionId: session.id,
    domain: domainId,
    mesh: {
      available: meshStatus?.available ?? false,
      tools: meshStatus?.tools ?? [],
    },
  });

  console.error(`[mesh-bridge] Session started: ${session.id} (${domainId})`);
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
// Server
// ============================================================================

export function startWebSocketServer(port: number): ReturnType<typeof Bun.serve> | null {
  // Start idempotency cache cleanup
  setInterval(cleanupIdempotencyCache, 60 * 1000);

  try {
    const server = Bun.serve({
      port,
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

    return server;
  } catch (error) {
    // Port already in use - another instance is running, which is fine
    // This happens when mesh spawns a second process for tool fetching
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      console.error(`[mesh-bridge] Port ${port} already in use (another instance running)`);
      return null;
    }
    throw error;
  }
}

export { sessions, meshStatus };
