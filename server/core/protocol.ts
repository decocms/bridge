/**
 * Mesh Bridge Protocol
 *
 * Defines the WebSocket protocol for communication between
 * browser extensions and the mesh-bridge server.
 *
 * Supports multiple domains (WhatsApp, LinkedIn, X, etc.) — RPA for any website
 */

// ============================================================================
// Frame Types (Client → Bridge)
// ============================================================================

export interface ConnectFrame {
  type: "connect";
  /** Client identifier (e.g., "chrome-extension") */
  client: string;
  /** Client version */
  version: string;
  /** Domain this client is connecting for (e.g., "whatsapp", "linkedin", "x") */
  domain: string;
  /** Current page URL */
  url?: string;
  /** Capabilities this client supports */
  capabilities?: string[];
}

export interface MessageFrame {
  type: "message";
  /** Unique request ID for idempotency */
  id: string;
  /** Domain this message is for */
  domain: string;
  /** Message content */
  text: string;
  /** Chat/conversation identifier */
  chatId: string;
  /** Whether this is a self-initiated message */
  isSelf?: boolean;
  /** Timestamp */
  timestamp: number;
  /** Domain-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface CommandFrame {
  type: "command";
  /** Unique request ID */
  id: string;
  /** Domain context */
  domain?: string;
  /** Command name (e.g., "/status", "/tools") */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Chat context */
  chatId?: string;
}

export interface PingFrame {
  type: "ping";
  id: string;
}

export interface ToolCallFrame {
  type: "tool_call";
  /** Unique request ID */
  id: string;
  /** Tool name on the mesh */
  tool: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
}

export interface EventFrame {
  type: "event";
  /** Event name */
  event: string;
  /** Domain this event is from */
  domain?: string;
  /** Event data */
  data: unknown;
}

export type ClientFrame =
  | ConnectFrame
  | MessageFrame
  | CommandFrame
  | PingFrame
  | ToolCallFrame
  | EventFrame;

// ============================================================================
// Frame Types (Bridge → Client)
// ============================================================================

export interface ConnectedFrame {
  type: "connected";
  /** Session ID assigned to this connection */
  sessionId: string;
  /** Bridge version */
  bridgeVersion: string;
  /** Domain that was matched */
  domain: string;
  /** Mesh status */
  mesh: {
    available: boolean;
    tools: string[];
    hasLLM: boolean;
  };
  /** Available domains */
  domains: Array<{ id: string; name: string }>;
}

export interface ResponseFrame {
  type: "response";
  /** Request ID this responds to */
  id: string;
  /** Response text */
  text: string;
  /** Whether this is the final response (for streaming) */
  isComplete: boolean;
}

export interface SendFrame {
  type: "send";
  /** Request ID this responds to */
  id: string;
  /** Chat to send to */
  chatId: string;
  /** Message text */
  text: string;
}

export interface PongFrame {
  type: "pong";
  id: string;
}

export interface ErrorFrame {
  type: "error";
  /** Request ID this responds to */
  id: string;
  /** Error code */
  code: string;
  /** Error message */
  message: string;
}

export interface BridgeEventFrame {
  type: "event";
  /** Event name */
  event: string;
  /** Event data */
  data: unknown;
}

export interface ToolResultFrame {
  type: "tool_result";
  /** Request ID this responds to */
  id: string;
  /** Tool result */
  result: unknown;
  /** Whether call succeeded */
  success: boolean;
}

export type BridgeFrame =
  | ConnectedFrame
  | ResponseFrame
  | SendFrame
  | PongFrame
  | ErrorFrame
  | BridgeEventFrame
  | ToolResultFrame;

// ============================================================================
// Session
// ============================================================================

export interface Session {
  id: string;
  client: string;
  version: string;
  /** Active domain for this session */
  domain: string;
  /** Current URL */
  url?: string;
  capabilities: string[];
  connectedAt: Date;
  lastActivity: Date;
  /** Conversation history per chat */
  conversations: Map<string, ConversationMessage[]>;
  /** Whether speaker mode is enabled (responses are spoken aloud) */
  speakerMode?: boolean;
  /** Last processed message text (for deduplication) */
  lastProcessedMessage?: string;
  /** Active gateway ID */
  activeGatewayId?: string;
  /** Active gateway name (for display) */
  activeGatewayName?: string;
  /** CLI monitor mode - shows all events from all sources */
  monitorMode?: boolean;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

// ============================================================================
// Helpers
// ============================================================================

export function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseFrame(data: string): ClientFrame | null {
  try {
    const frame = JSON.parse(data);
    if (!frame.type) return null;
    return frame as ClientFrame;
  } catch {
    return null;
  }
}

export function stringifyFrame(frame: BridgeFrame): string {
  return JSON.stringify(frame);
}
