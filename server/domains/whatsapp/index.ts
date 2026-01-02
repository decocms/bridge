/**
 * WhatsApp Domain
 *
 * First implementation of a mesh-bridge domain.
 * Allows reading WhatsApp messages with AI and transforming them into mesh commands.
 */

import type { Domain, DomainMessage, DomainContext, DomainTool } from "../../core/domain.ts";
import { isMeshReady } from "../../core/mesh-client.ts";
import { Agent, type LocalTool } from "../../core/agent.ts";
import { spawn } from "bun";

// ============================================================================
// WhatsApp-specific Types
// ============================================================================

interface WhatsAppMessage extends DomainMessage {
  speakerMode?: boolean; // When true, also speak response out loud
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

const WHATSAPP_SYSTEM_PROMPT = `You are Guilherme's personal AI assistant running on his Mac. You are powered by Gemini Flash.

*System Tools:*
• SAY_TEXT(text) - Speak aloud (auto-detects PT/EN)
• LIST_APPS - Running applications
• LIST_FILES(path) - Files in ~/Projects/
• READ_FILE(path) - Read file content
• RUN_SHELL(command) - Shell command
• GET_CLIPBOARD / SET_CLIPBOARD
• SEND_NOTIFICATION(message)
• STOP_SPEAKING - Stop voice

*Mesh Tools:*
• LIST_CONNECTIONS - Show all MCPs in the mesh
• LIST_CONNECTION_TOOLS(connectionId) - List tools from ONE specific connection
• CALL_MESH_TOOL(connectionId, toolName, args) - Execute a tool on a connection

When user asks about "mesh", "tools", or "connections":
- Use LIST_CONNECTIONS first to show available MCPs
- Use LIST_CONNECTION_TOOLS to see tools from a specific connection (ALWAYS pick one connection at a time)
- Use CALL_MESH_TOOL to execute a specific tool

*Rules:*
• Keep responses SHORT (1-2 paragraphs)
• Match user's language (PT/EN)
• Use *bold* _italic_ \`code\` for formatting
• Call tools when needed - don't just describe them
• Never output XML or function tags`;

// ============================================================================
// Domain Tools
// ============================================================================

const tools: DomainTool[] = [
  {
    name: "SAY_TEXT",
    description:
      "Make the Mac speak text out loud. Auto-detects language (Portuguese/English) and picks appropriate voice.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak" },
        voice: {
          type: "string",
          description:
            "Voice override (optional). If not provided, auto-detects: 'Luciana' for Portuguese, 'Samantha' for English",
        },
        rate: {
          type: "number",
          description: "Speech rate (optional, words per minute, default ~175)",
        },
      },
      required: ["text"],
    },
    execute: async (input, _ctx) => {
      const { text, voice, rate } = input as { text: string; voice?: string; rate?: number };

      // Use Siri voice by default (multilingual), or fall back to language-specific voices
      const detectedLang = detectLanguage(text);
      const selectedVoice = voice || DEFAULT_VOICE;

      // Build the say command arguments
      const args: string[] = ["-v", selectedVoice];

      if (rate) {
        args.push("-r", String(rate));
      }

      args.push(text);

      console.error(`[SAY_TEXT] Speaking with voice ${selectedVoice} (lang: ${detectedLang})`);

      try {
        const proc = spawn(["say", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });

        await proc.exited;

        return {
          success: true,
          message: `Spoke: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
          voice: selectedVoice,
          detectedLanguage: detectedLang,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to speak",
        };
      }
    },
  },
  {
    name: "STOP_SPEAKING",
    description: "Stop any currently playing text-to-speech",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_input, ctx) => {
      const stopped = stopSpeaking();

      // Also notify client
      ctx.send({
        type: "speaking_ended",
        id: "stop",
        cancelled: true,
      } as any);

      return {
        success: true,
        wasSpeaking: stopped,
        message: stopped ? "Stopped speaking" : "Nothing was playing",
      };
    },
  },
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
  {
    name: "SET_SPEAKER_MODE",
    description: "Enable or disable speaker mode. When enabled, AI responses are spoken aloud.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Whether to enable speaker mode" },
      },
      required: ["enabled"],
    },
    execute: async (input, ctx) => {
      const { enabled } = input as { enabled: boolean };

      // Store in session
      ctx.session.speakerMode = enabled;

      console.error(`[whatsapp] Speaker mode set to: ${enabled}`);

      return {
        success: true,
        speakerMode: enabled,
        message: enabled
          ? "Speaker mode enabled - responses will be spoken aloud"
          : "Speaker mode disabled",
      };
    },
  },
  {
    name: "GET_SPEAKER_MODE",
    description: "Get the current speaker mode state",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async (_input, ctx) => {
      return {
        speakerMode: ctx.session.speakerMode ?? false,
      };
    },
  },
  // ============================================================================
  // System Tools
  // ============================================================================
  {
    name: "LIST_APPS",
    description: "List currently running applications on macOS",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const proc = spawn(
          [
            "osascript",
            "-e",
            'tell application "System Events" to get name of every process whose background only is false',
          ],
          { stdout: "pipe", stderr: "pipe" },
        );

        const output = await new Response(proc.stdout).text();
        await proc.exited;

        const apps = output.trim().split(", ").filter(Boolean);
        return { apps, count: apps.length };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to list apps" };
      }
    },
  },
  {
    name: "LIST_FILES",
    description:
      "List files and folders in a directory. Only works in whitelisted paths (/Users/guilherme/Projects/)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list (must be under ~/Projects/)" },
        showHidden: { type: "boolean", description: "Include hidden files" },
      },
      required: ["path"],
    },
    execute: async (input) => {
      const { path, showHidden } = input as { path: string; showHidden?: boolean };
      const allowedPaths = ["/Users/guilherme/Projects/"];

      // Security: Only allow whitelisted paths
      const isAllowed = allowedPaths.some((allowed) => path.startsWith(allowed));
      if (!isAllowed) {
        return { error: `Path not allowed. Must be under: ${allowedPaths.join(", ")}` };
      }

      try {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(path, { withFileTypes: true });

        const files = entries
          .filter((e) => showHidden || !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));

        return { path, files, count: files.length };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to list files" };
      }
    },
  },
  {
    name: "READ_FILE",
    description:
      "Read a file's contents. Only works in whitelisted paths (/Users/guilherme/Projects/)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        maxLines: { type: "number", description: "Maximum lines to read (default: 100)" },
      },
      required: ["path"],
    },
    execute: async (input) => {
      const { path, maxLines = 100 } = input as { path: string; maxLines?: number };
      const allowedPaths = ["/Users/guilherme/Projects/"];

      const isAllowed = allowedPaths.some((allowed) => path.startsWith(allowed));
      if (!isAllowed) {
        return { error: `Path not allowed. Must be under: ${allowedPaths.join(", ")}` };
      }

      try {
        const { readFile, stat } = await import("node:fs/promises");
        const stats = await stat(path);

        if (stats.isDirectory()) {
          return { error: "Path is a directory, not a file" };
        }

        const content = await readFile(path, "utf-8");
        const lines = content.split("\n");
        const truncated = lines.length > maxLines;

        return {
          path,
          content: lines.slice(0, maxLines).join("\n"),
          totalLines: lines.length,
          truncated,
          size: stats.size,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to read file" };
      }
    },
  },
  {
    name: "GET_CLIPBOARD",
    description: "Get the current clipboard content (text only)",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const proc = spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;

        return { content: output, length: output.length };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to get clipboard" };
      }
    },
  },
  {
    name: "SET_CLIPBOARD",
    description: "Set the clipboard content",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to copy to clipboard" },
      },
      required: ["text"],
    },
    execute: async (input) => {
      const { text } = input as { text: string };
      try {
        const proc = spawn(["pbcopy"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(text);
        proc.stdin.end();
        await proc.exited;

        return { success: true, length: text.length };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to set clipboard" };
      }
    },
  },
  {
    name: "SEND_NOTIFICATION",
    description: "Send a macOS notification",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification message" },
        sound: { type: "string", description: "Sound name (e.g., 'Glass', 'Ping', 'Pop')" },
      },
      required: ["title", "message"],
    },
    execute: async (input) => {
      const { title, message, sound } = input as { title: string; message: string; sound?: string };
      try {
        const script = sound
          ? `display notification "${message}" with title "${title}" sound name "${sound}"`
          : `display notification "${message}" with title "${title}"`;

        const proc = spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;

        return { success: true, title, message };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to send notification" };
      }
    },
  },
  {
    name: "RUN_SHELL",
    description: "Run a shell command. Use with caution - only for simple commands",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory (must be under ~/Projects/)" },
      },
      required: ["command"],
    },
    execute: async (input) => {
      const { command, cwd } = input as { command: string; cwd?: string };
      const allowedPaths = ["/Users/guilherme/Projects/"];

      // If cwd is specified, validate it
      if (cwd) {
        const isAllowed = allowedPaths.some((allowed) => cwd.startsWith(allowed));
        if (!isAllowed) {
          return {
            error: `Working directory not allowed. Must be under: ${allowedPaths.join(", ")}`,
          };
        }
      }

      // Block dangerous commands
      const dangerous = ["rm -rf /", "sudo", "chmod 777", "mkfs", "dd if="];
      for (const d of dangerous) {
        if (command.includes(d)) {
          return { error: `Dangerous command blocked: ${d}` };
        }
      }

      try {
        const proc = spawn(["bash", "-c", command], {
          stdout: "pipe",
          stderr: "pipe",
          cwd: cwd || "/Users/guilherme/Projects/",
        });

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;

        return {
          stdout: stdout.slice(0, 5000), // Limit output
          stderr: stderr.slice(0, 1000),
          exitCode,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Failed to run command" };
      }
    },
  },
  // ============================================================================
  // MCP Mesh Integration Tools
  // ============================================================================
  {
    name: "LIST_CONNECTIONS",
    description: "List all MCP connections in the mesh with their tool counts",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async (_input, ctx) => {
      console.error("[LIST_CONNECTIONS] Starting...");
      try {
        const connections = await ctx.meshClient.listConnections();
        console.error("[LIST_CONNECTIONS] Got", connections.length, "connections");

        if (!connections || connections.length === 0) {
          return {
            connections: [],
            count: 0,
            note: "No connections available. Configure the CONNECTION binding in Mesh UI.",
          };
        }

        return {
          connections: connections.map((c) => ({
            id: c.id,
            name: c.title,
            tools: c.toolCount,
          })),
          count: connections.length,
          note: "Use LIST_MESH_TOOLS to see all tools, or CALL_MESH_TOOL to execute one.",
        };
      } catch (error) {
        console.error("[LIST_CONNECTIONS] Error:", error);
        return {
          error: error instanceof Error ? error.message : "Failed to list connections",
          hint: "Make sure the CONNECTION binding (@deco/connection) is configured in Mesh UI.",
        };
      }
    },
  },
  {
    name: "LIST_CONNECTION_TOOLS",
    description:
      "List tools from a SPECIFIC mesh connection. Use LIST_CONNECTIONS first to get connection IDs.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection ID to list tools from (get this from LIST_CONNECTIONS first)",
        },
      },
      required: ["connectionId"],
    },
    execute: async (input, ctx) => {
      const { connectionId } = input as { connectionId: string };
      console.error(`[LIST_CONNECTION_TOOLS] Fetching tools for connection: ${connectionId}`);

      try {
        // Get connection details including tools
        const connections = await ctx.meshClient.listConnections();
        const connection = connections.find((c) => c.id === connectionId);

        if (!connection) {
          return {
            error: `Connection not found: ${connectionId}`,
            availableConnections: connections.map((c) => ({ id: c.id, name: c.title })),
            hint: "Use one of the available connection IDs above.",
          };
        }

        // Fetch the full connection with tools via COLLECTION_CONNECTIONS_GET
        const { callMeshTool, getConnectionBindingId } = await import("../../core/mesh-client.ts");
        const connBindingId = getConnectionBindingId();

        if (!connBindingId) {
          return {
            error: "CONNECTION binding not configured",
            hint: "Configure @deco/connection binding in Mesh UI.",
          };
        }

        const fullConnection = await callMeshTool<{
          id: string;
          title: string;
          tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
        }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

        const tools = fullConnection?.tools || [];
        console.error(`[LIST_CONNECTION_TOOLS] Got ${tools.length} tools for ${connection.title}`);

        return {
          connectionId,
          connectionName: fullConnection?.title || connection.title,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description?.slice(0, 100),
          })),
          count: tools.length,
          note: "Use CALL_MESH_TOOL(connectionId, toolName, args) to execute a tool.",
        };
      } catch (error) {
        console.error("[LIST_CONNECTION_TOOLS] Error:", error);
        return {
          error: error instanceof Error ? error.message : "Failed to list connection tools",
          connectionId,
        };
      }
    },
  },
  {
    name: "CALL_MESH_TOOL",
    description: "Call a tool from a specific MCP connection in the mesh",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "Connection ID (get from LIST_CONNECTIONS)" },
        toolName: { type: "string", description: "Name of the tool to call" },
        args: { type: "object", description: "Arguments to pass to the tool" },
      },
      required: ["connectionId", "toolName"],
    },
    execute: async (input, ctx) => {
      const {
        connectionId,
        toolName,
        args = {},
      } = input as {
        connectionId: string;
        toolName: string;
        args?: Record<string, unknown>;
      };
      try {
        console.error(`[CALL_MESH_TOOL] Calling ${toolName} on ${connectionId}`);
        const result = await ctx.meshClient.callConnectionTool(connectionId, toolName, args);
        return { connectionId, toolName, result };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Failed to call mesh tool",
          connectionId,
          toolName,
        };
      }
    },
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

// Default voice - using Luciana (PT-BR) as it's always available
// Siri voices like "Siri Nicky" need to be downloaded in System Settings
const DEFAULT_VOICE = "Luciana";

// Fallback voices
const PT_FALLBACK_VOICE = "Luciana";
const EN_FALLBACK_VOICE = "Samantha";

// Track active say process for stop functionality
let activeSayProcess: ReturnType<typeof spawn> | null = null;
let activeSaySession: string | null = null;

/**
 * Kill any active say process
 */
export function stopSpeaking(): boolean {
  if (activeSayProcess) {
    console.error("[stopSpeaking] Killing active say process");
    try {
      activeSayProcess.kill();
      activeSayProcess = null;
      activeSaySession = null;
      return true;
    } catch (error) {
      console.error("[stopSpeaking] Failed to kill process:", error);
      return false;
    }
  }
  return false;
}

/**
 * Detect the language of a text (Portuguese vs English)
 * Uses simple heuristics based on common words and characters
 */
function detectLanguage(text: string): "pt" | "en" {
  const lowerText = text.toLowerCase();

  // Portuguese-specific patterns
  const ptPatterns = [
    // Common Portuguese words
    /\b(você|voce|está|estou|estão|não|nao|sim|olá|ola|obrigado|obrigada)\b/,
    /\b(para|como|isso|esse|essa|aqui|ali|muito|pouco|agora)\b/,
    /\b(tenho|temos|fazer|posso|pode|quero|preciso|gostaria)\b/,
    /\b(bom|boa|dia|noite|tarde|bem|mal|legal|bacana)\b/,
    /\b(arquivo|pasta|aplicativo|projeto|código|lista)\b/,
    /\b(executando|rodando|funcionando|pronto|feito)\b/,
    // Portuguese characters
    /[ãõáéíóúâêîôûàèìòùç]/,
    // Portuguese contractions and common endings
    /\b\w+(ção|ções|mente|ando|endo|indo)\b/,
  ];

  // English-specific patterns
  const enPatterns = [
    /\b(the|and|you|your|this|that|what|which|where|when)\b/,
    /\b(is|are|was|were|have|has|had|will|would|could)\b/,
    /\b(running|working|doing|looking|getting|making)\b/,
    /\b(file|folder|app|application|project|code|list)\b/,
  ];

  let ptScore = 0;
  let enScore = 0;

  for (const pattern of ptPatterns) {
    if (pattern.test(lowerText)) ptScore++;
  }

  for (const pattern of enPatterns) {
    if (pattern.test(lowerText)) enScore++;
  }

  console.error(`[detectLanguage] PT: ${ptScore}, EN: ${enScore}`);

  // Default to Portuguese if scores are equal (user is Brazilian)
  return ptScore >= enScore ? "pt" : "en";
}

async function executeSay(
  text: string,
  voice: string | undefined,
  message: WhatsAppMessage,
  send: DomainContext["send"],
  aiPrefix: string,
  sessionId?: string,
): Promise<void> {
  try {
    // Use specified voice or auto-detect based on language
    const detectedLang = detectLanguage(text);
    const selectedVoice = voice || (detectedLang === "pt" ? PT_FALLBACK_VOICE : EN_FALLBACK_VOICE);
    console.error(
      `[executeSay] Using voice: ${selectedVoice} (lang: ${detectedLang}, requested: ${voice || "auto"})`,
    );

    // Notify client that speaking started
    send({
      type: "speaking_started",
      id: message.id,
      text: text.slice(0, 100),
    } as any);

    const proc = spawn(["say", "-v", selectedVoice, text], { stdout: "pipe", stderr: "pipe" });

    // Track the process for stop functionality
    activeSayProcess = proc;
    activeSaySession = sessionId || null;

    const exitCode = await proc.exited;

    // Clear tracking
    activeSayProcess = null;
    activeSaySession = null;

    // Notify client that speaking ended
    send({
      type: "speaking_ended",
      id: message.id,
      cancelled: exitCode !== 0,
    } as any);

    if (exitCode === 0) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}🔊 _Spoke (${selectedVoice}):_ "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
      });
    } else {
      console.error(`[executeSay] Process exited with code ${exitCode} (may have been stopped)`);
    }
  } catch (error) {
    activeSayProcess = null;
    activeSaySession = null;
    console.error(`[executeSay] Error:`, error);
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}❌ Speech error: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}

// ============================================================================
// Message Handler
// ============================================================================

async function handleMessage(message: WhatsAppMessage, ctx: DomainContext): Promise<void> {
  const { meshClient, session, send, config } = ctx;
  const aiPrefix = config.aiPrefix || "🤖 ";

  // Check if mesh is ready (has credentials)
  if (!isMeshReady()) {
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}⚠️ *Waiting for Mesh credentials...*

The Mesh Bridge needs to receive credentials from MCP Mesh.

*To fix:*
• Restart Mesh (bun dev)
• Or force refresh the connection in the UI`,
    });
    return;
  }

  // Strip the command prefix (! or /) for display, keep for command detection
  let messageText = message.text.trim();
  const hasPrefix = messageText.startsWith("!") || messageText.startsWith("/");

  console.error(
    `[whatsapp] Received message: "${messageText.slice(0, 100)}" (hasPrefix: ${hasPrefix})`,
  );

  // SERVER-SIDE DEDUPLICATION: Check if we just processed this exact message
  const messageKey = messageText.slice(0, 100);

  if (session.lastProcessedMessage === messageKey) {
    console.error(`[whatsapp] Duplicate message detected, skipping`);
    return;
  }

  // Update cache BEFORE processing
  session.lastProcessedMessage = messageKey;

  // Check for /say command (direct command from user)
  // Match: /say text OR /say:voice text
  const sayMatch = messageText.match(/^\/say(?::(\w+))?\s+(.+)$/is);
  console.error(`[whatsapp] /say match:`, sayMatch ? "YES" : "NO");
  if (sayMatch) {
    const voice = sayMatch[1] || undefined;
    const textToSay = sayMatch[2];
    console.error(`[whatsapp] Executing say: voice=${voice}, text="${textToSay.slice(0, 50)}"`);

    await executeSay(textToSay, voice, message, send, aiPrefix);
    return;
  }

  // Check for natural "say" requests (e.g., "!diga ola", "!fale hello", "!say hi")
  const naturalSayMatch = messageText.match(/^[!/]?(?:diga|fale|say|speak|fala)\s+(.+)$/is);
  console.error(`[whatsapp] natural say match:`, naturalSayMatch ? "YES" : "NO");
  if (naturalSayMatch) {
    const textToSay = naturalSayMatch[1];
    console.error(`[whatsapp] Executing natural say: "${textToSay.slice(0, 50)}"`);
    await executeSay(textToSay, undefined, message, send, aiPrefix);
    return;
  }

  // ===========================================================================
  // Shortcut Commands
  // ===========================================================================

  // /apps - List running applications
  if (messageText.match(/^\/apps?\s*$/i)) {
    try {
      const proc = spawn(
        [
          "osascript",
          "-e",
          'tell application "System Events" to get name of every process whose background only is false',
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      const apps = output.trim().split(", ").filter(Boolean);
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}*Running Apps (${apps.length}):*\n${apps
          .slice(0, 20)
          .map((a) => `• ${a}`)
          .join("\n")}${apps.length > 20 ? `\n_...e mais ${apps.length - 20}_` : ""}`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /files [path] - List files
  const filesMatch = messageText.match(/^\/files?\s*(.*)?$/i);
  if (filesMatch) {
    const path = filesMatch[1]?.trim() || "/Users/guilherme/Projects/";
    const allowedPaths = ["/Users/guilherme/Projects/"];
    const isAllowed = allowedPaths.some((a) => path.startsWith(a));

    if (!isAllowed) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Path not allowed. Use ~/Projects/`,
      });
      return;
    }

    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(path, { withFileTypes: true });
      const files = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}*${path}*\n${files.slice(0, 25).join("\n")}${files.length > 25 ? `\n_...e mais ${files.length - 25}_` : ""}`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /read <file> - Read file
  const readMatch = messageText.match(/^\/read\s+(.+)$/i);
  if (readMatch) {
    const filePath = readMatch[1].trim();
    const allowedPaths = ["/Users/guilherme/Projects/"];
    const isAllowed = allowedPaths.some((a) => filePath.startsWith(a));

    if (!isAllowed) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Path not allowed`,
      });
      return;
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").slice(0, 30);
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}*${filePath.split("/").pop()}*\n\`\`\`\n${lines.join("\n").slice(0, 1500)}\n\`\`\`${content.split("\n").length > 30 ? "\n_...truncated_" : ""}`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /tools - List mesh connections (use !list tools for <connection> for specific tools)
  if (messageText.match(/^\/tools?\s*$/i)) {
    try {
      const connections = await meshClient.listConnections();
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}*Mesh Connections (${connections.length}):*\n${connections
          .slice(0, 20)
          .map((c) => `• *${c.title}* (${c.toolCount} tools)\n   \`${c.id}\``)
          .join(
            "\n",
          )}${connections.length > 20 ? `\n_...and ${connections.length - 20} more_` : ""}\n\n_Tip: Say "list tools from <connection>" to see specific tools_`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /notify <message> - Send notification
  const notifyMatch = messageText.match(/^\/notify\s+(.+)$/i);
  if (notifyMatch) {
    const msg = notifyMatch[1].trim();
    try {
      const proc = spawn(
        ["osascript", "-e", `display notification "${msg}" with title "WhatsApp Bridge"`],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}✅ Notification sent!`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /run <command> - Run shell command
  const runMatch = messageText.match(/^\/run\s+(.+)$/i);
  if (runMatch) {
    const command = runMatch[1].trim();
    const dangerous = ["rm -rf /", "sudo", "chmod 777", "mkfs", "dd if="];
    for (const d of dangerous) {
      if (command.includes(d)) {
        send({
          type: "send",
          id: message.id,
          chatId: message.chatId,
          text: `${aiPrefix}❌ Comando bloqueado: ${d}`,
        });
        return;
      }
    }

    try {
      const proc = spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: "/Users/guilherme/Projects/",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      const output = (stdout || stderr).trim().slice(0, 1500);
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}\`\`\`\n$ ${command}\n${output || "(sem output)"}\n\`\`\`\n_Exit: ${exitCode}_`,
      });
    } catch (error) {
      send({
        type: "send",
        id: message.id,
        chatId: message.chatId,
        text: `${aiPrefix}❌ Error: ${error}`,
      });
    }
    return;
  }

  // /help - Show help
  if (messageText.match(/^\/help\s*$/i)) {
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: `${aiPrefix}*Available Commands:*

📢 \`/say <text>\` - Speak aloud
📢 \`/say:Voice <text>\` - Speak with specific voice

📁 \`/files [path]\` - List files
📄 \`/read <file>\` - Read file
🖥️ \`/apps\` - Running apps
⚙️ \`/run <cmd>\` - Run command

🔧 \`/tools\` - List Mesh tools
🔔 \`/notify <msg>\` - Send notification

💬 \`!message\` - Chat with AI`,
    });
    return;
  }

  // Strip the ! prefix for LLM (it's just a trigger, not part of the message)
  let userMessage = messageText;
  if (userMessage.startsWith("!")) {
    userMessage = userMessage.slice(1).trim();
  }

  // Get conversation history
  let conversation = session.conversations.get(message.chatId);
  if (!conversation) {
    conversation = [];
    session.conversations.set(message.chatId, conversation);
  }

  // Convert domain tools to LocalTools for the Agent
  const localTools: LocalTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    execute: async (args: Record<string, unknown>) => {
      // Create a minimal context for tool execution
      const toolCtx = {
        meshClient,
        session,
        send,
        config: ctx.config,
      };
      return t.execute(args, toolCtx);
    },
  }));

  // Create Agent with two-phase architecture
  const agent = new Agent(meshClient, localTools, {
    fastModel: config.fastModel || config.defaultModel || "google/gemini-2.5-flash",
    smartModel: config.smartModel, // Optional - uses fastModel if not set
    maxTokens: 2048,
    temperature: 0.7,
    maxRouterIterations: 3,
    maxExecutorIterations: 5,
    onModeChange: (mode) => {
      // Notify the extension UI about mode changes
      send({
        type: "agent_mode_changed",
        mode,
      } as any);
    },
  });

  // Get conversation history for context
  const conversationHistory = conversation.map((c) => ({
    role: c.role as "user" | "assistant",
    content: c.content,
  }));

  try {
    const response = await agent.run(userMessage, conversationHistory);

    // Update conversation
    conversation.push({
      role: "user",
      content: userMessage,
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

    // Clean up response - strip any function call XML that leaked through
    let responseText = response
      // Remove <function_calls>...</function_calls> blocks
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
      // Remove <invoke>...</invoke> blocks
      .replace(/<invoke[\s\S]*?<\/invoke>/g, "")
      // Remove <function_result>...</function_result> blocks
      .replace(/<function_result>[\s\S]*?<\/function_result>/g, "")
      // Remove any remaining XML-like tags
      .replace(/<\/?[a-z_]+>/gi, "")
      // Clean up multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Always ensure response starts with robot emoji
    if (!responseText.startsWith("🤖")) {
      responseText = `${aiPrefix}${responseText}`;
    }

    // Send response
    send({
      type: "send",
      id: message.id,
      chatId: message.chatId,
      text: responseText,
    });

    // If speaker mode is ON (from session OR message flag), also speak the response
    const speakerEnabled = session.speakerMode === true || message.speakerMode === true;
    if (speakerEnabled) {
      console.error(`[whatsapp] Speaker mode ON - speaking response`);
      try {
        // Clean up the response for speaking (remove formatting, emojis, etc.)
        const textToSpeak = responseText
          .replace(/🤖/g, "")
          .replace(/\*([^*]+)\*/g, "$1") // Remove *bold*
          .replace(/_([^_]+)_/g, "$1") // Remove _italic_
          .replace(/~([^~]+)~/g, "$1") // Remove ~strike~
          .replace(/`([^`]+)`/g, "$1") // Remove `code`
          .replace(/•/g, "") // Remove bullets
          .replace(/[🔊🎯🚀💡❤️👋😊😅🧠📁📄🖥️⚙️🔧🔔💬✅❌⚠️]/g, "") // Remove emojis
          .replace(/\n+/g, " ") // Replace newlines with spaces
          .trim();

        if (textToSpeak) {
          // Auto-detect language for voice selection
          const detectedLang = detectLanguage(textToSpeak);
          const voice = detectedLang === "pt" ? PT_FALLBACK_VOICE : EN_FALLBACK_VOICE;
          console.error(`[whatsapp] Speaking with voice: ${voice} (detected: ${detectedLang})`);

          // Notify client that speaking started
          send({
            type: "speaking_started",
            id: message.id,
            text: textToSpeak.slice(0, 100),
          } as any);

          const proc = spawn(["say", "-v", voice, textToSpeak], {
            stdout: "pipe",
            stderr: "pipe",
          });

          // Track for stop functionality
          activeSayProcess = proc;
          activeSaySession = session.id;

          const exitCode = await proc.exited;

          activeSayProcess = null;
          activeSaySession = null;

          // Notify client that speaking ended
          send({
            type: "speaking_ended",
            id: message.id,
            cancelled: exitCode !== 0,
          } as any);

          console.error(`[whatsapp] Spoke response with ${voice} (exit: ${exitCode})`);
        }
      } catch (speakError) {
        console.error(`[whatsapp] Speaker mode failed:`, speakError);
      }
    }
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
  cmd: { id: string; command: string; args?: Record<string, unknown> | string[] },
  ctx: DomainContext,
): Promise<void> {
  const aiPrefix = ctx.config.aiPrefix || "🤖 ";
  const { command, args } = cmd;

  switch (command) {
    case "set_speaker_mode": {
      const enabled = (args as { enabled?: boolean })?.enabled ?? false;
      ctx.session.speakerMode = enabled;
      console.error(`[whatsapp] Speaker mode set to: ${enabled} via command`);
      ctx.send({
        type: "response",
        id: cmd.id,
        text: enabled ? "🔊 Speaker mode enabled" : "🔇 Speaker mode disabled",
        isComplete: true,
      });
      return;
    }

    case "get_speaker_mode": {
      ctx.send({
        type: "response",
        id: cmd.id,
        text: ctx.session.speakerMode ? "🔊 Speaker mode is ON" : "🔇 Speaker mode is OFF",
        isComplete: true,
      });
      return;
    }

    case "stop_speaking": {
      const stopped = stopSpeaking();
      ctx.send({
        type: "speaking_ended",
        id: cmd.id,
        cancelled: true,
      } as any);
      ctx.send({
        type: "response",
        id: cmd.id,
        text: stopped ? "🛑 Stopped speaking" : "Nothing was playing",
        isComplete: true,
      });
      return;
    }

    case "/help":
      ctx.send({
        type: "response",
        id: cmd.id,
        text: `${aiPrefix}*WhatsApp Bridge Commands*

/help - Show this help
/status - Check bridge status
/clear - Clear conversation
/chats - List recent chats

Just chat naturally for AI responses!`,
        isComplete: true,
      });
      return;

    case "/chats":
      ctx.send({
        type: "event",
        event: "request_chats",
        data: {},
      });
      ctx.send({
        type: "response",
        id: cmd.id,
        text: `${aiPrefix}Fetching chat list...`,
        isComplete: true,
      });
      return;

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
