/**
 * Bridge Event Types
 *
 * Defines the CloudEvent types for communication between
 * the bridge and the Pilot agent via the mesh event bus.
 */

// ============================================================================
// Event Type Constants
// ============================================================================

export const EVENT_TYPES = {
  // Outgoing (Bridge publishes)
  USER_MESSAGE: "user.message.received",
  USER_COMMAND: "user.command.issued",

  // Incoming (Bridge subscribes to)
  TASK_CREATED: "agent.task.created",
  TASK_STARTED: "agent.task.started",
  TASK_PROGRESS: "agent.task.progress",
  TASK_TOOL_CALLED: "agent.task.tool_called",
  TASK_COMPLETED: "agent.task.completed",
  TASK_FAILED: "agent.task.failed",

  // Interface-specific responses
  RESPONSE_WHATSAPP: "agent.response.whatsapp",
  RESPONSE_CLI: "agent.response.cli",
} as const;

// ============================================================================
// User Message Event (Bridge → Pilot)
// ============================================================================

export interface UserMessageEvent {
  /** The message text */
  text: string;
  /** Source interface (whatsapp, cli, etc.) */
  source: string;
  /** Chat/conversation ID */
  chatId?: string;
  /** Sender info */
  sender?: {
    id?: string;
    name?: string;
  };
  /** Reply-to message ID */
  replyTo?: string;
  /** Interface-specific metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Agent Response Event (Pilot → Bridge)
// ============================================================================

export interface AgentResponseEvent {
  taskId: string;
  source: string;
  chatId?: string;
  /** Response text */
  text: string;
  /** Optional image URL */
  imageUrl?: string;
  /** Whether this is the final response */
  isFinal: boolean;
}

// ============================================================================
// Task Progress Event (Pilot → Bridge)
// ============================================================================

export interface TaskProgressEvent {
  taskId: string;
  source: string;
  chatId?: string;
  message: string;
  percent?: number;
  step?: string;
}

// ============================================================================
// Task Completed Event (Pilot → Bridge)
// ============================================================================

export interface TaskCompletedEvent {
  taskId: string;
  source: string;
  chatId?: string;
  response: string;
  summary?: string;
  duration: number;
  toolsUsed: string[];
}

// ============================================================================
// Task Failed Event (Pilot → Bridge)
// ============================================================================

export interface TaskFailedEvent {
  taskId: string;
  source: string;
  chatId?: string;
  error: string;
  canRetry: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the response event type for a source
 */
export function getResponseEventType(source: string): string {
  return `agent.response.${source}`;
}
