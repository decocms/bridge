/**
 * WhatsApp Domain
 *
 * First implementation of a mesh-bridge domain.
 * Allows reading WhatsApp messages with AI and transforming them into mesh commands.
 */

import type { Domain, DomainMessage, DomainContext, DomainTool } from "../../core/domain.ts";

// ============================================================================
// WhatsApp-specific Types
// ============================================================================

interface WhatsAppMessage extends DomainMessage {
  metadata?: {
    isGroup?: boolean;
    sender?: string;
    senderPhone?: string;
    mentions?: string[];
  };
}

// ============================================================================
// System Prompt
// ============================================================================

const WHATSAPP_SYSTEM_PROMPT = `You are a helpful AI assistant accessible through WhatsApp. You're running locally on the user's computer via MCP Mesh Bridge.

## Important Limitations
You are in CHAT mode only - you CANNOT execute commands, run code, or call tools directly. You can only have text conversations. If the user asks you to run commands or access files, explain this limitation honestly.

## WhatsApp Formatting (USE THESE!)
WhatsApp has its own formatting - do NOT use Markdown! Use these instead:
- *bold text* - wrap with single asterisks
- _italic text_ - wrap with single underscores
- ~strikethrough~ - wrap with tildes
- \`\`\`code block\`\`\` - wrap with triple backticks
- \`monospace\` - wrap with single backticks
- > quote - start line with >

## Response Guidelines
- Keep responses *concise* - this is a messaging app, not a document
- Use bullet points and short paragraphs
- Break up long responses with line breaks
- Use emojis sparingly but appropriately 🚀
- Be conversational, friendly, and direct

## Language
Respond in the same language the user writes to you. If they write in Portuguese, respond in Portuguese. If English, respond in English.`;

// ============================================================================
// Domain Tools
// ============================================================================

const tools: DomainTool[] = [
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

      // Send via WebSocket to extension
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
      // This would trigger the extension to scrape chat list
      ctx.send({
        type: "event",
        event: "request_chats",
        data: {},
      });

      // For now, return placeholder - real impl would wait for response
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
];

// ============================================================================
// Message Handler
// ============================================================================

async function handleMessage(message: WhatsAppMessage, ctx: DomainContext): Promise<void> {
  const { meshClient, session, send, config } = ctx;
  const aiPrefix = config.aiPrefix || "🤖 ";

  // Get conversation history
  let conversation = session.conversations.get(message.chatId);
  if (!conversation) {
    conversation = [];
    session.conversations.set(message.chatId, conversation);
  }

  // AI response via mesh LLM
  const messages = [
    { role: "system" as const, content: WHATSAPP_SYSTEM_PROMPT },
    ...conversation.map((c) => ({ role: c.role, content: c.content })),
    { role: "user" as const, content: message.text },
  ];

  try {
    const response = await meshClient.generateWithLLM(
      config.defaultModel || "anthropic/claude-sonnet-4",
      messages,
      { maxTokens: 2048, temperature: 0.7 },
    );

    // Update conversation
    conversation.push({
      role: "user",
      content: message.text,
      timestamp: new Date(),
    });
    conversation.push({
      role: "assistant",
      content: response,
      timestamp: new Date(),
    });

    // Keep last 20 messages
    while (conversation.length > 20) {
      conversation.shift();
    }

    // Send response
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}${response}`,
    });
  } catch (error) {
    send({
      type: "error",
      id: message.id,
      code: "LLM_ERROR",
      message: error instanceof Error ? error.message : "AI response failed",
    });
  }
}

// ============================================================================
// Command Handler
// ============================================================================

async function handleCommand(
  command: string,
  args: string[],
  ctx: DomainContext,
): Promise<{ handled: boolean; response?: string }> {
  const aiPrefix = ctx.config.aiPrefix || "🤖 ";

  switch (command) {
    case "/help":
      return {
        handled: true,
        response: `${aiPrefix}*WhatsApp Bridge Commands*

/help - Show this help
/status - Check bridge status
/clear - Clear conversation
/chats - List recent chats

Just chat naturally for AI responses!`,
      };

    case "/chats":
      ctx.send({
        type: "event",
        event: "request_chats",
        data: {},
      });
      return {
        handled: true,
        response: `${aiPrefix}Fetching chat list...`,
      };

    default:
      return { handled: false };
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

  urlPatterns: [
    /^https?:\/\/(web\.)?whatsapp\.com/,
    /^https?:\/\/.*\.whatsapp\.com/,
  ],

  systemPrompt: WHATSAPP_SYSTEM_PROMPT,
  tools,

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

