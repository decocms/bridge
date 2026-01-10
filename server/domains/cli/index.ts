/**
 * CLI Domain (Event-Driven)
 *
 * A CLI interface that:
 * - Publishes user.message.received events to the mesh
 * - Subscribes to agent.response.cli events
 * - Can optionally monitor ALL events for debugging
 *
 * Works exactly like WhatsApp but for terminal.
 */

import type { Domain, DomainMessage, DomainContext, DomainTool } from "../../core/domain.ts";
import { callMeshTool, getEventBusBindingId } from "../../core/mesh-client.ts";
import {
  EVENT_TYPES,
  type UserMessageEvent,
  type AgentResponseEvent,
  type TaskProgressEvent,
} from "../../events.ts";

// ============================================================================
// Event Publishing
// ============================================================================

async function publishEvent(type: string, data: Record<string, unknown>): Promise<boolean> {
  const eventBusId = getEventBusBindingId();
  if (!eventBusId) {
    console.error(`[cli] EVENT_BUS not configured, skipping event: ${type}`);
    return false;
  }

  try {
    await callMeshTool(eventBusId, "EVENT_PUBLISH", { type, data });
    console.error(`[cli] Published ${type}`);
    return true;
  } catch (error) {
    console.error(`[cli] Failed to publish ${type}:`, error);
    return false;
  }
}

// ============================================================================
// CLI-Specific Domain Tools
// ============================================================================

const cliTools: DomainTool[] = [
  {
    name: "SEND_RESPONSE",
    description: "Send a response to the CLI",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Session identifier" },
        text: { type: "string", description: "Response text" },
      },
      required: ["text"],
    },
    execute: async (input, ctx) => {
      const { text } = input as { chatId?: string; text: string };
      ctx.send({
        type: "response",
        id: `tool-${Date.now()}`,
        text,
        isComplete: true,
      });
      return { success: true, textLength: text.length };
    },
  },
];

// ============================================================================
// Message Handler (Event-Driven)
// ============================================================================

async function handleMessage(message: DomainMessage, ctx: DomainContext): Promise<void> {
  const { send, session } = ctx;

  const eventBusId = getEventBusBindingId();
  console.error(`[cli] handleMessage - eventBusId: ${eventBusId}, PID: ${process.pid}`);

  if (!eventBusId) {
    console.error(`[cli] ❌ No EVENT_BUS binding - Mesh not connected`);
    send({
      type: "error",
      id: message.id,
      code: "mesh_not_connected",
      message: "Waiting for Mesh credentials",
    });
    return;
  }

  const messageText = message.text.trim();
  if (!messageText) {
    return;
  }

  console.error(`[cli] Received: "${messageText.slice(0, 100)}"`);

  // Deduplication
  const messageKey = messageText.slice(0, 100);
  if (session.lastProcessedMessage === messageKey) {
    console.error(`[cli] Duplicate message, skipping`);
    return;
  }
  session.lastProcessedMessage = messageKey;

  // Publish event to Pilot
  const eventData: UserMessageEvent = {
    text: messageText,
    source: "cli",
    chatId: message.chatId || session.id,
    sender: { name: "cli-user" },
    replyTo: message.id,
  };

  const published = await publishEvent(
    EVENT_TYPES.USER_MESSAGE,
    eventData as unknown as Record<string, unknown>,
  );

  if (!published) {
    console.error(`[cli] ❌ Failed to publish to Pilot`);
    send({
      type: "error",
      id: message.id,
      code: "pilot_unreachable",
      message: "Could not reach Pilot agent",
    });
  }
}

// ============================================================================
// Agent Response Handler (from events)
// ============================================================================

export async function handleAgentResponse(
  event: AgentResponseEvent,
  ctx: DomainContext,
): Promise<void> {
  const { send } = ctx;

  console.error(`[cli] handleAgentResponse called for task ${event.taskId}`);
  console.error(`[cli] Response text (first 100): ${event.text?.slice(0, 100)}...`);

  send({
    type: "response",
    id: `resp-${event.taskId}`,
    text: event.text || "",
    isComplete: event.isFinal,
  });
}

// ============================================================================
// Progress Handler (from events)
// ============================================================================

export async function handleAgentProgress(
  event: TaskProgressEvent,
  ctx: DomainContext,
): Promise<void> {
  ctx.send({ type: "agent_progress", message: event.message } as any);
}

// ============================================================================
// Command Handler
// ============================================================================

async function handleCommand(
  cmd: { id: string; command: string; args?: Record<string, unknown> | string[] },
  ctx: DomainContext,
): Promise<void> {
  const { command } = cmd;

  switch (command) {
    case "new_thread": {
      // Clear thread history
      ctx.session.lastProcessedMessage = undefined;
      ctx.send({
        type: "response",
        id: cmd.id,
        text: "🧹 Thread cleared",
        isComplete: true,
      });
      return;
    }

    case "monitor": {
      // Toggle monitor mode (show all events from all sources)
      const enabled = !ctx.session.monitorMode;
      ctx.session.monitorMode = enabled;
      ctx.send({
        type: "response",
        id: cmd.id,
        text: enabled ? "👁️ Monitor mode ON - showing all events" : "👁️ Monitor mode OFF",
        isComplete: true,
      });
      return;
    }

    default:
      ctx.send({
        type: "error",
        id: cmd.id,
        code: "UNKNOWN_COMMAND",
        message: `Unknown command: ${command}`,
      });
  }
}

// ============================================================================
// Domain Export
// ============================================================================

export const cliDomain: Domain = {
  id: "cli",
  name: "CLI",
  description: "Terminal interface for Mesh - send messages and monitor events",
  icon: "🖥️",

  // CLI doesn't match URLs - it's explicitly selected
  urlPatterns: [],

  tools: cliTools,

  handleMessage,
  handleCommand,

  onInit: async (ctx) => {
    console.log(`[cli] Domain initialized for session ${ctx.session.id}`);
    // Send welcome message on init
    ctx.send({
      type: "response",
      id: "welcome",
      text: "Connected to Mesh Bridge. Type a message to send to Pilot.",
      isComplete: true,
    });
  },

  onDestroy: async (ctx) => {
    console.log(`[cli] Domain destroyed for session ${ctx.session.id}`);
  },
};

export default cliDomain;
