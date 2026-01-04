/**
 * WhatsApp Domain (Event-Driven)
 *
 * A simplified domain that:
 * - Publishes user.message.received events to the mesh
 * - Subscribes to agent.response.whatsapp events
 * - Handles WhatsApp-specific commands directly
 *
 * The actual AI processing is done by Pilot (mcps/pilot).
 */

import type { Domain, DomainMessage, DomainContext, DomainTool } from "../../core/domain.ts";
import { callMeshTool, getEventBusBindingId, isMeshReady } from "../../core/mesh-client.ts";
import { spawn } from "bun";
import {
  EVENT_TYPES,
  type UserMessageEvent,
  type AgentResponseEvent,
  type TaskProgressEvent,
} from "../../events.ts";

// ============================================================================
// Types
// ============================================================================

interface WhatsAppMessage extends DomainMessage {
  speakerMode?: boolean;
  metadata?: {
    isGroup?: boolean;
    sender?: string;
    senderPhone?: string;
    mentions?: string[];
  };
}

// ============================================================================
// Event Publishing
// ============================================================================

async function publishEvent(type: string, data: Record<string, unknown>): Promise<boolean> {
  const eventBusId = getEventBusBindingId();
  if (!eventBusId) {
    console.error(`[whatsapp] EVENT_BUS not configured, skipping event: ${type}`);
    return false;
  }

  try {
    await callMeshTool(eventBusId, "EVENT_PUBLISH", { type, data });
    console.error(`[whatsapp] Published ${type}`);
    return true;
  } catch (error) {
    console.error(`[whatsapp] Failed to publish ${type}:`, error);
    return false;
  }
}

// ============================================================================
// WhatsApp-Specific Domain Tools
// ============================================================================

const whatsappTools: DomainTool[] = [
  {
    name: "SEND_MESSAGE",
    description: "Send a message to a WhatsApp chat",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat identifier" },
        text: { type: "string", description: "Message text" },
      },
      required: ["chatId", "text"],
    },
    execute: async (input, ctx) => {
      const { chatId, text } = input as { chatId: string; text: string };
      ctx.send({
        type: "send",
        id: `tool-${Date.now()}`,
        chatId,
        text,
      });
      return { success: true, chatId, textLength: text.length };
    },
  },
  {
    name: "GET_CHATS",
    description: "Get list of recent WhatsApp chats",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max chats to return" },
      },
    },
    execute: async (_input, ctx) => {
      ctx.send({ type: "event", event: "request_chats", data: {} });
      return { pending: true, message: "Requesting chat list from extension" };
    },
  },
  {
    name: "GET_MESSAGES",
    description: "Get messages from a specific WhatsApp chat",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat identifier" },
        limit: { type: "number", description: "Max messages to return" },
      },
      required: ["chatId"],
    },
    execute: async (input, ctx) => {
      const { chatId, limit } = input as { chatId: string; limit?: number };
      ctx.send({
        type: "event",
        event: "request_messages",
        data: { chatId, limit: limit || 20 },
      });
      return { pending: true, message: "Requesting messages from extension" };
    },
  },
  {
    name: "SET_SPEAKER_MODE",
    description: "Enable or disable speaker mode (AI speaks responses aloud)",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Enable/disable speaker mode" },
      },
      required: ["enabled"],
    },
    execute: async (input, ctx) => {
      const { enabled } = input as { enabled: boolean };
      ctx.session.speakerMode = enabled;
      return { success: true, speakerMode: enabled };
    },
  },
];

// ============================================================================
// Shortcut Commands (local, no agent needed)
// ============================================================================

// No local shortcut commands - bridge is a pure MCP-DOM bridge
// All commands are handled by Pilot via events

// ============================================================================
// Message Handler (Event-Driven)
// ============================================================================

async function handleMessage(message: WhatsAppMessage, ctx: DomainContext): Promise<void> {
  const { send, config, session } = ctx;
  const aiPrefix = config.aiPrefix || "🤖 ";

  // Check if mesh is ready (now using event bus only - always ready in STDIO mode)
  const eventBusId = getEventBusBindingId();

  // Debug: Log detailed state for troubleshooting hot reload issues
  console.error(
    `[whatsapp] handleMessage - eventBusId: ${eventBusId}, isMeshReady: ${isMeshReady()}, PID: ${process.pid}`,
  );
  console.error(
    `[whatsapp] ENV check - MESH_TOKEN: ${process.env.MESH_TOKEN ? "set" : "NOT SET"}, MESH_STATE: ${process.env.MESH_STATE ? `${process.env.MESH_STATE.length} chars` : "NOT SET"}`,
  );

  if (!eventBusId) {
    console.error(`[whatsapp] ❌ No EVENT_BUS binding found! Sending error to user.`);
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}⚠️ *Waiting for Mesh credentials...*\n\nRestart Mesh or refresh the connection.`,
    });
    return;
  }

  let messageText = message.text.trim();
  const hasPrefix =
    messageText.startsWith("!") || messageText.startsWith("-") || messageText.startsWith("/");

  console.error(`[whatsapp] Received: "${messageText.slice(0, 100)}" (hasPrefix: ${hasPrefix})`);

  // Deduplication
  const messageKey = messageText.slice(0, 100);
  if (session.lastProcessedMessage === messageKey) {
    console.error(`[whatsapp] Duplicate message, skipping`);
    return;
  }
  session.lastProcessedMessage = messageKey;

  // Strip legacy command prefix if present (backwards compatibility)
  let userMessage = messageText;
  if (userMessage.startsWith("!") || userMessage.startsWith("-")) {
    userMessage = userMessage.slice(1).trim();
  }

  // Skip empty messages
  if (!userMessage) {
    console.error(`[whatsapp] Empty message after stripping prefix, skipping`);
    return;
  }

  // Show processing state
  send({ type: "processing_started" } as any);

  // Publish event to Pilot
  const eventData: UserMessageEvent = {
    text: userMessage,
    source: "whatsapp",
    chatId: message.chatId,
    sender: message.metadata?.sender ? { name: message.metadata.sender } : undefined,
    replyTo: message.id,
    metadata: {
      speakerMode: session.speakerMode,
      ...message.metadata,
    },
  };

  const published = await publishEvent(
    EVENT_TYPES.USER_MESSAGE,
    eventData as unknown as Record<string, unknown>,
  );

  if (!published) {
    send({ type: "processing_ended" } as any);
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}⚠️ Could not reach Pilot agent. Make sure it's running in the mesh.`,
    });
  }

  // Note: Response will come via agent.response.whatsapp event subscription
  // which is handled by handleAgentResponse below
}

// ============================================================================
// Markdown to WhatsApp Formatting
// ============================================================================

/**
 * Convert Markdown formatting to WhatsApp-compatible formatting
 *
 * WhatsApp supports:
 * - *bold* (markdown uses **bold**)
 * - _italic_ (markdown uses *italic* or _italic_)
 * - ~strikethrough~ (same as markdown)
 * - ```code``` (same as markdown)
 * - `monospace` (same as markdown)
 *
 * Also ensures proper newlines for lists and sections
 */
function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  let result = text;

  // Remove XML/function call tags
  result = result
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<invoke[\s\S]*?<\/invoke>/g, "");

  // Convert bold: **text** or __text__ → *text*
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  result = result.replace(/__([^_]+)__/g, "*$1*");

  // Convert italic: *text* (single asterisk, but only if not inside a bold)
  // This is tricky - markdown uses *text* for italic but WhatsApp uses _text_
  // We've already converted **bold** to *bold*, so single * should become _
  // But we need to be careful not to break already-converted bold
  // Actually, let's leave single asterisks alone since WhatsApp interprets them as bold

  // Convert headers: # Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Ensure list items have proper newlines
  // Add newline before list items if not already present
  result = result.replace(/([^\n])\n([*•\-]\s)/g, "$1\n\n$2");

  // Convert markdown bullets (- or * at start) to • for cleaner look
  result = result.replace(/^[\-\*]\s+/gm, "• ");

  // Ensure double newlines between sections (headers, paragraphs)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Clean up any excessive whitespace
  result = result.trim();

  return result;
}

// ============================================================================
// Agent Response Handler (from events)
// ============================================================================

export async function handleAgentResponse(
  event: AgentResponseEvent,
  ctx: DomainContext,
): Promise<void> {
  const { send, session, config } = ctx;
  const aiPrefix = config.aiPrefix || "🤖 ";

  console.error(`[whatsapp] handleAgentResponse called for task ${event.taskId}`);
  console.error(`[whatsapp] Response text (first 100): ${event.text?.slice(0, 100)}...`);

  // Signal processing ended (response received = done)
  send({ type: "processing_ended" } as any);

  // Convert markdown to WhatsApp formatting
  let responseText: string;
  try {
    responseText = markdownToWhatsApp(event.text || "");
  } catch (error) {
    console.error(`[whatsapp] markdownToWhatsApp error:`, error);
    responseText = event.text || "Error processing response";
  }

  if (!responseText.startsWith("🤖")) {
    responseText = `${aiPrefix}${responseText}`;
  }

  console.error(`[whatsapp] Sending to chatId: ${event.chatId}`);

  // Send text response
  send({
    type: "send",
    id: `resp-${event.taskId}`,
    chatId: event.chatId || "",
    text: responseText,
  });

  // Send image if present
  if (event.imageUrl) {
    send({
      type: "send_image",
      id: `img-${event.taskId}`,
      chatId: event.chatId,
      imageUrl: event.imageUrl,
      caption: "",
    } as any);
  }

  // Speaker mode
  if (session.speakerMode && event.isFinal) {
    try {
      const textToSpeak = responseText
        .replace(/🤖/g, "")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/[🔊🎯🚀💡❤️👋😊😅🧠📁📄🖥️⚙️🔧🔔💬✅❌⚠️]/g, "")
        .replace(/\n+/g, " ")
        .trim();

      if (textToSpeak) {
        send({
          type: "speaking_started",
          id: event.taskId,
          text: textToSpeak.slice(0, 100),
        } as any);
        const proc = spawn(["say", textToSpeak], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        send({ type: "speaking_ended", id: event.taskId, cancelled: false } as any);
      }
    } catch (error) {
      console.error(`[whatsapp] Speaker mode failed:`, error);
    }
  }
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
  const { command, args } = cmd;

  switch (command) {
    case "set_speaker_mode": {
      const enabled = (args as { enabled?: boolean })?.enabled ?? false;
      ctx.session.speakerMode = enabled;
      ctx.send({
        type: "response",
        id: cmd.id,
        text: enabled ? "🔊 Speaker mode enabled" : "🔇 Speaker mode disabled",
        isComplete: true,
      });
      return;
    }

    case "stop_speaking": {
      try {
        spawn(["killall", "say"], { stdout: "ignore", stderr: "ignore" });
      } catch {}
      ctx.send({ type: "speaking_ended", id: cmd.id, cancelled: true } as any);
      ctx.send({ type: "response", id: cmd.id, text: "🛑 Stopped speaking", isComplete: true });
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

export const whatsappDomain: Domain = {
  id: "whatsapp",
  name: "WhatsApp",
  description: "Chat with AI through WhatsApp - message yourself to interact with your mesh",
  icon: "https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg",

  urlPatterns: [/^https?:\/\/(web\.)?whatsapp\.com/, /^https?:\/\/.*\.whatsapp\.com/],

  systemPrompt: "", // Not used anymore - Pilot has its own prompt
  tools: whatsappTools,

  handleMessage,
  handleCommand,

  onInit: async (ctx) => {
    console.log(`[whatsapp] Domain initialized for session ${ctx.session.id}`);
  },

  onDestroy: async (ctx) => {
    console.log(`[whatsapp] Domain destroyed for session ${ctx.session.id}`);
  },
};

export default whatsappDomain;
