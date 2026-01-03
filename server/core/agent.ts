/**
 * Two-Phase Agent Architecture
 *
 * Phase 1: ROUTER (fast model, 4 meta-tools)
 * - list_local_tools: List bridge's local tools (names + short descriptions)
 * - list_mesh_tools: List mesh connection tools (names + short descriptions)
 * - get_tools: Get full schema for specific tools before using them
 * - run_task: Execute a task with specific tools loaded
 *
 * Phase 2: EXECUTOR (smart model, specific tools loaded)
 * - Only runs when router calls run_task
 * - Has only the tools the router selected
 * - Executes and returns to router
 */

import type { MeshClient } from "./mesh-client.ts";
import type { ToolDefinition, Message } from "./mesh-client.ts";
import { config } from "../config.ts";
import {
  createTask,
  updateTaskStatus,
  addTaskProgress,
  addToolUsed,
  getRecentTasks,
  getTaskSummary,
  type Task,
} from "./task-manager.ts";

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  /** Model for routing (fast/cheap) - e.g., "google/gemini-2.5-flash" */
  fastModel: string;
  /** Model for execution (smart/capable) - defaults to fastModel if not set */
  smartModel?: string;
  /** Max tokens for responses */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Max router iterations before giving up */
  maxRouterIterations?: number;
  /** Max executor iterations for tool calls */
  maxExecutorIterations?: number;
  /** Callback when agent mode changes (FAST/SMART) */
  onModeChange?: (mode: "FAST" | "SMART") => void;
  /** Callback to send progress updates to UI */
  onProgress?: (message: string) => void;
  /** Callback to send events (like images) to UI */
  sendEvent?: (event: string, data: Record<string, unknown>) => void;
}

// Connection cache - shared across agent instances for the session
interface ConnectionCache {
  connections: Array<{
    id: string;
    title: string;
    toolCount: number;
    tools: Array<{ name: string; description?: string }>;
  }> | null;
  lastFetched: number;
}

const connectionCache: ConnectionCache = {
  connections: null,
  lastFetched: 0,
};

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolSummary {
  name: string;
  description: string; // Truncated to ~100 chars
  source: "local" | "mesh";
  connectionId?: string; // For mesh tools
  connectionName?: string;
}

export interface ToolSchema {
  name: string;
  description: string; // Full description
  inputSchema: Record<string, unknown>;
  source: "local" | "mesh";
  connectionId?: string;
}

// ============================================================================
// Router Meta-Tools
// ============================================================================

function getRouterSystemPrompt(): string {
  const allowedPaths =
    config.terminal.allowedPaths.length > 0
      ? config.terminal.allowedPaths.join(", ")
      : "/Users/guilherme/Projects/";

  return `You are a FAST PLANNING agent. Your job is to:
1. Understand what the user wants
2. Explore available tools AND relevant files
3. Create a detailed execution plan for the SMART executor

**Your Tools:**
- list_local_tools: See file/shell/notification tools
- list_mesh_tools: See API tools (READ DESCRIPTIONS - they have instructions!)
- explore_files: List directory contents to find interesting files
- peek_file: Read a file to see if it's relevant
- execute_task: Hand off to SMART executor with plan + tools + context

**WORKFLOW:**

STEP 1: DISCOVER TOOLS
- Call list_local_tools() AND list_mesh_tools()
- Note which tools are relevant to the user's request

STEP 2: EXPLORE FILES (if user mentions files/projects)
- Use explore_files("${allowedPaths}mesh-bridge/") to see project structure
- Use peek_file to read READMEs or key files
- Identify the most interesting files for the task

STEP 3: CREATE EXECUTION PLAN
Call execute_task with:
- task: Detailed step-by-step instructions (numbered list)
- tools: ALL tools executor needs
- context: Include file contents you gathered in step 2!

**EXAMPLE - Writing an article about a project:**

1. Call list_mesh_tools() → find TONE_OF_VOICE, COLLECTION_ARTICLES_CREATE
2. Call explore_files("/Users/guilherme/Projects/mesh-bridge/") → see README.md, server/, etc.
3. Call peek_file("...mesh-bridge/README.md") → understand the project
4. Call execute_task with:
   - task: "Write an engaging article about mesh-bridge. Use the README content and tone of voice. Call COLLECTION_ARTICLES_CREATE with full content."
   - tools: [TONE_OF_VOICE, COLLECTION_ARTICLES_CREATE]
   - context: "README content: ... (paste what you read)"

**RULES:**
- Simple questions → respond directly (no tools)
- "List tools" requests → call list_mesh_tools, respond with results
- Complex tasks → explore files, gather context, then execute_task
- Include gathered file contents in the context field!
- Match user's language (PT/EN)

**File System Access:** ${allowedPaths}`;
}

function createRouterTools(localTools: LocalTool[], meshClient: MeshClient): ToolDefinition[] {
  // Get allowed paths for file exploration
  const allowedPaths =
    config.terminal.allowedPaths.length > 0
      ? config.terminal.allowedPaths.join(", ")
      : "/Users/guilherme/Projects/";

  return [
    {
      name: "list_local_tools",
      description: "List available local system tools (files, shell, notifications, speech, etc.)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_mesh_tools",
      description:
        "List available MCP mesh tools from external connections (APIs, databases, etc.). READ DESCRIPTIONS - they contain important instructions!",
      inputSchema: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
            description: "Optional: filter by specific connection ID",
          },
        },
      },
    },
    // File exploration tools for FAST agent to discover relevant files
    {
      name: "explore_files",
      description: `List files in a directory to discover project structure. Use this to find interesting files before planning. Allowed paths: ${allowedPaths}`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to explore (must be within allowed paths)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "peek_file",
      description:
        "Read a file to understand its contents. Use this to gauge if a file is relevant for the task. Returns first 200 lines.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to read",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "get_tool_schemas",
      description:
        "Get full schemas for specific tools before using them. Call this to understand tool parameters.",
      inputSchema: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Tool name" },
                source: {
                  type: "string",
                  enum: ["local", "mesh"],
                  description: "Where the tool comes from",
                },
                connectionId: { type: "string", description: "For mesh tools, the connection ID" },
              },
              required: ["name", "source"],
            },
            description: "List of tools to get schemas for",
          },
        },
        required: ["tools"],
      },
    },
    {
      name: "execute_task",
      description: `Execute a task with a detailed plan. The executor is SMART and CAN explore files.

Example:
{
  "task": "Write an article about MCP + WhatsApp integration:\\n1. First, explore /Users/guilherme/Projects/context/ to find tone of voice\\n2. Use TONE_OF_VOICE tool to get writing style\\n3. Read relevant files about the project\\n4. Create the article with proper tone using COLLECTION_ARTICLES_CREATE",
  "tools": [
    {"name": "LIST_FILES", "source": "local"},
    {"name": "READ_FILE", "source": "local"},
    {"name": "TONE_OF_VOICE", "source": "mesh", "connectionId": "conn_abc"},
    {"name": "COLLECTION_ARTICLES_CREATE", "source": "mesh", "connectionId": "conn_abc"}
  ]
}

IMPORTANT: 
- Write a DETAILED step-by-step plan in the task field
- Include LOCAL tools (READ_FILE, LIST_FILES) so executor can explore
- Include ALL mesh tools that might be useful`,
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Detailed step-by-step execution plan. Be specific about what files to read, what to look for, etc.",
          },
          context: {
            type: "string",
            description:
              "Optional notes or hints for the executor (not file contents - it can read those itself)",
          },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "EXACT tool name from list results" },
                source: { type: "string", enum: ["local", "mesh"] },
                connectionId: {
                  type: "string",
                  description: "For mesh tools: connectionId from list",
                },
              },
              required: ["name", "source"],
            },
            description: "Tools the executor should use",
          },
        },
        required: ["task", "tools"],
      },
    },
  ];
}

// ============================================================================
// Agent Class
// ============================================================================

export class Agent {
  private meshClient: MeshClient;
  private localTools: LocalTool[];
  private config: AgentConfig;
  private currentMode: "FAST" | "SMART" = "FAST";
  private currentTaskId: string | null = null;

  constructor(meshClient: MeshClient, localTools: LocalTool[], config: AgentConfig) {
    this.meshClient = meshClient;
    this.localTools = localTools;
    this.config = {
      maxTokens: 2048,
      temperature: 0.7,
      maxRouterIterations: 10,
      maxExecutorIterations: 30,
      ...config,
    };
  }

  /**
   * Send progress update to UI and log to task
   */
  private sendProgress(message: string): void {
    this.config.onProgress?.(message);
    // Also log to task file
    if (this.currentTaskId) {
      addTaskProgress(this.currentTaskId, message).catch(() => {});
    }
  }

  /**
   * Track tool usage in the current task
   */
  private trackToolUsed(toolName: string): void {
    if (this.currentTaskId) {
      addToolUsed(this.currentTaskId, toolName).catch(() => {});
    }
  }

  /**
   * Set the current agent mode and notify callback
   */
  private setMode(mode: "FAST" | "SMART"): void {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
      this.config.onModeChange?.(mode);
    }
  }

  /**
   * Get cached connections with tools, fetching if needed
   */
  private async getConnections(): Promise<
    Array<{
      id: string;
      title: string;
      toolCount: number;
      tools: Array<{ name: string; description?: string }>;
    }>
  > {
    const now = Date.now();

    // Return cached if fresh
    if (connectionCache.connections && now - connectionCache.lastFetched < CACHE_TTL) {
      return connectionCache.connections;
    }

    // Fetch fresh
    try {
      const connections = await this.meshClient.listConnections();
      connectionCache.connections = connections;
      connectionCache.lastFetched = now;

      // Cache connection names for mesh-client logging
      const { cacheConnectionName } = await import("./mesh-client.ts");
      for (const conn of connections) {
        cacheConnectionName(conn.id, conn.title);
      }

      return connections;
    } catch (error) {
      // Silently fail - will use cached or empty
      return connectionCache.connections || [];
    }
  }

  // Schema cache for full tool schemas (inputSchema)
  private schemaCache: Map<
    string,
    { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
  > = new Map();

  /**
   * Format args for compact logging
   */
  private formatArgsForLog(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) {
      // Show values for small objects
      const parts = keys.map((k) => {
        const v = args[k];
        if (typeof v === "string") return `${k}:"${v.slice(0, 30)}${v.length > 30 ? "..." : ""}"`;
        if (typeof v === "number" || typeof v === "boolean") return `${k}:${v}`;
        return `${k}:<${typeof v}>`;
      });
      return parts.join(", ");
    }
    // Just show key names for large objects
    return keys.join(", ");
  }

  /**
   * Format result for compact logging
   */
  private formatResultForLog(result: unknown): string {
    if (result === null || result === undefined) return "null";
    if (typeof result === "string")
      return `"${result.slice(0, 50)}${result.length > 50 ? "..." : ""}"`;
    if (typeof result === "number" || typeof result === "boolean") return String(result);
    if (typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if ("error" in obj) return `error: ${obj.error}`;
      if ("success" in obj) return `success: ${obj.success}`;
      if ("id" in obj) return `id: ${obj.id}`;
      const keys = Object.keys(obj);
      return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "..." : ""}}`;
    }
    return String(result).slice(0, 50);
  }

  /**
   * Get connection details with full tool schemas (for execution)
   */
  private async getConnectionDetails(connectionId: string): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  } | null> {
    // Check schema cache first
    if (this.schemaCache.has(connectionId)) {
      return this.schemaCache.get(connectionId)!;
    }

    // Fetch full details from mesh (includes inputSchema)
    try {
      const { callMeshTool, getConnectionBindingId } = await import("./mesh-client.ts");
      const connBindingId = getConnectionBindingId();
      if (!connBindingId) return null;

      // API returns { item: { ... } } wrapper
      const result = await callMeshTool<{
        item?: {
          id: string;
          title: string;
          tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
        };
      }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

      const conn = result?.item;
      const details = { tools: conn?.tools || [] };
      this.schemaCache.set(connectionId, details);
      return details;
    } catch (error) {
      // Silently fail - return null
      return null;
    }
  }

  /**
   * Run the agent on a user message
   */
  async run(userMessage: string, conversationHistory: Message[] = []): Promise<string> {
    console.error(
      `\n[FAST] ─── ${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}`,
    );

    // Create task for tracking
    const task = await createTask(userMessage);
    this.currentTaskId = task.id;

    this.sendProgress("🔍 Analyzing request...");

    // Start in FAST mode
    this.setMode("FAST");

    try {
      // Phase 1: Router
      const result = await this.runRouter(userMessage, conversationHistory);

      // Mark task as completed
      await updateTaskStatus(this.currentTaskId, "completed", result);
      this.currentTaskId = null;

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Agent] Fatal error: ${errorMsg}`);
      this.sendProgress(`❌ Error: ${errorMsg}`);

      // Mark task as error
      if (this.currentTaskId) {
        await updateTaskStatus(this.currentTaskId, "error", undefined, errorMsg);
        this.currentTaskId = null;
      }

      return `Sorry, I encountered an error: ${errorMsg}`;
    }
  }

  /**
   * Phase 1: Router - Uses fast model with 4 meta-tools
   */
  private async runRouter(userMessage: string, conversationHistory: Message[]): Promise<string> {
    const messages: Message[] = [
      { role: "system", content: getRouterSystemPrompt() },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ];

    const routerTools = createRouterTools(this.localTools, this.meshClient);
    const usedTools: string[] = [];

    // Track tool calls for loop detection
    const toolCallCounts = new Map<string, number>();
    const MAX_SAME_TOOL = 5; // Max times same tool can be called (execute_task may need retries after validation)

    for (let i = 0; i < (this.config.maxRouterIterations || 3); i++) {
      const result = await this.callLLM(this.config.fastModel, messages, routerTools);

      // If no tool calls, return the response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (usedTools.length > 0) {
          console.error(`[FAST] Tools used: ${usedTools.join(" → ")}`);
        }
        return result.text || "I couldn't generate a response.";
      }

      // Process tool calls
      for (const tc of result.toolCalls) {
        // Loop detection: don't call same tool too many times
        const callCount = (toolCallCounts.get(tc.name) || 0) + 1;
        toolCallCounts.set(tc.name, callCount);

        if (callCount > MAX_SAME_TOOL) {
          console.error(`[FAST] ⚠️ Skipping ${tc.name} (called ${callCount} times)`);
          messages.push({
            role: "user",
            content: `[Warning] You already called ${tc.name} ${callCount - 1} times. Use the results you have or respond to the user.`,
          });
          continue;
        }

        usedTools.push(tc.name);
        const toolResult = await this.executeRouterTool(
          tc.name,
          tc.arguments,
          userMessage,
          conversationHistory,
          usedTools, // Pass history to enforce workflow
        );

        // If execute_task was called, it returns the final response
        if (tc.name === "execute_task" && typeof toolResult === "string") {
          console.error(`[FAST] Tools used: ${usedTools.join(" → ")}`);
          return toolResult;
        }

        // Add tool result to messages for next iteration
        messages.push({
          role: "assistant",
          content: result.text || `Calling ${tc.name}...`,
        });
        messages.push({
          role: "user",
          content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2)}`,
        });
      }
    }

    console.error(`[FAST] Tools used: ${usedTools.join(" → ")} (limit reached)`);
    return "I couldn't complete the request within the iteration limit.";
  }

  /**
   * Execute a router meta-tool
   */
  private async executeRouterTool(
    name: string,
    args: Record<string, unknown>,
    originalTask: string,
    conversationHistory: Message[],
    previousTools: string[] = [],
  ): Promise<unknown> {
    switch (name) {
      case "list_local_tools": {
        const tools = this.localTools.map((t) => ({
          name: t.name,
          description: t.description.slice(0, 100) + (t.description.length > 100 ? "..." : ""),
          source: "local",
        }));
        this.sendProgress(`📦 Found ${tools.length} local tools`);
        return { tools, count: tools.length };
      }

      case "explore_files": {
        const path = args.path as string;
        if (!path) {
          return { error: "Missing 'path' parameter" };
        }

        // Find the LIST_FILES tool
        const listFilesTool = this.localTools.find((t) => t.name === "LIST_FILES");
        if (!listFilesTool) {
          return { error: "LIST_FILES tool not available" };
        }

        try {
          const result = (await listFilesTool.execute({ path })) as {
            content?: Array<{ text?: string }>;
          };
          // Parse result if it's a text response
          if (result?.content?.[0]?.text) {
            const parsed = JSON.parse(result.content[0].text);
            this.sendProgress(`📂 Found ${parsed.count || 0} items in ${path.split("/").pop()}`);
            return {
              path: parsed.path,
              files: parsed.files?.slice(0, 30), // Limit to 30 files for context
              count: parsed.count,
              hint: "Select interesting files for the executor to read",
            };
          }
          return result;
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Failed to list files" };
        }
      }

      case "peek_file": {
        const path = args.path as string;
        if (!path) {
          return { error: "Missing 'path' parameter" };
        }

        // Find the READ_FILE tool
        const readFileTool = this.localTools.find((t) => t.name === "READ_FILE");
        if (!readFileTool) {
          return { error: "READ_FILE tool not available" };
        }

        try {
          const result = (await readFileTool.execute({ path, limit: 200 })) as {
            content?: Array<{ text?: string }>;
          };
          // Parse and truncate for context
          if (result?.content?.[0]?.text) {
            const parsed = JSON.parse(result.content[0].text);
            this.sendProgress(`📄 Read ${parsed.path?.split("/").pop() || path}`);
            return {
              path: parsed.path,
              preview: parsed.content?.slice(0, 3000), // Truncate for router context
              totalLines: parsed.totalLines,
              hint: "Decide if this file is relevant for the task",
            };
          }
          return result;
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Failed to read file" };
        }
      }

      case "list_mesh_tools": {
        const connectionId = args.connectionId as string | undefined;
        try {
          // Get all connections with their tools (single call, cached)
          const connections = await this.getConnections();

          if (connectionId) {
            // Filter to specific connection
            const conn = connections.find((c) => c.id === connectionId);
            if (!conn) {
              return { error: `Connection not found: ${connectionId}` };
            }

            const tools = conn.tools.map((t) => ({
              name: t.name,
              description: (t.description || "").slice(0, 100),
              source: "mesh",
              connectionId,
            }));
            return { tools, count: tools.length, connectionId, connectionName: conn.title };
          } else {
            // Flatten all tools with descriptions for easy searching
            const allTools = connections.flatMap((c) =>
              c.tools.map((t) => ({
                name: t.name,
                description: (t.description || "").slice(0, 150),
                connectionId: c.id,
                connectionName: c.title,
              })),
            );

            this.sendProgress(
              `🔌 Found ${allTools.length} mesh tools from ${connections.length} connections`,
            );
            return {
              allTools,
              totalToolCount: allTools.length,
              hint: "Select MULTIPLE related tools for the task. Read descriptions carefully.",
            };
          }
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Failed to list mesh tools" };
        }
      }

      case "get_tool_schemas": {
        const toolRequests = args.tools as
          | Array<{
              name: string;
              source: string;
              connectionId?: string;
            }>
          | undefined;

        if (!toolRequests || !Array.isArray(toolRequests) || toolRequests.length === 0) {
          return {
            error: "Missing 'tools' array in get_tool_schemas call.",
            hint: "Call with {tools: [{name: 'TOOL_NAME', source: 'mesh', connectionId: '...'}]}",
          };
        }

        const schemas: ToolSchema[] = [];

        // Get cached connections to help find tools without connectionId
        const cachedConnections = await this.getConnections();

        for (const req of toolRequests) {
          if (req.source === "local") {
            const tool = this.localTools.find((t) => t.name === req.name);
            if (tool) {
              schemas.push({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                source: "local",
              });
            }
          } else if (req.source === "mesh") {
            // Auto-find connectionId if not provided
            let connectionId = req.connectionId;
            if (!connectionId) {
              const connWithTool = cachedConnections.find((c) =>
                c.tools.some((t) => t.name === req.name),
              );
              if (connWithTool) {
                connectionId = connWithTool.id;
              }
            }

            if (!connectionId) {
              continue; // Can't find this tool
            }

            try {
              const { callMeshTool, getConnectionBindingId } = await import("./mesh-client.ts");
              const connBindingId = getConnectionBindingId();
              if (connBindingId) {
                const result = await callMeshTool<{
                  item?: {
                    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
                  };
                }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

                const tool = result?.item?.tools?.find((t) => t.name === req.name);
                if (tool) {
                  schemas.push({
                    name: tool.name,
                    description: tool.description || "",
                    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                    source: "mesh",
                    connectionId,
                  });
                }
              }
            } catch {
              // Skip tools that fail to load
            }
          }
        }

        return { schemas, count: schemas.length };
      }

      case "execute_task": {
        const task = args.task as string | undefined;
        const context = args.context as string | undefined;
        const toolRequests = args.tools as
          | Array<{
              name: string;
              source: string;
              connectionId?: string;
            }>
          | undefined;

        // Enforce workflow: must list tools before executing
        const hasListedTools = previousTools.some(
          (t) => t === "list_mesh_tools" || t === "list_local_tools",
        );
        if (!hasListedTools) {
          return {
            error: "You MUST call list_mesh_tools or list_local_tools FIRST before execute_task.",
            hint: "Step 1: List tools. Step 2: Explore (read files, gather context). Step 3: Execute with full context.",
            workflow: "list_tools → explore → execute_task(task, context, tools)",
          };
        }

        // Validate required fields
        if (!task || typeof task !== "string") {
          return {
            error: "Invalid execute_task call. Missing 'task' field.",
            hint: "Call execute_task with {task: 'description', context: 'gathered info', tools: [...]}",
            receivedArgs: args,
          };
        }

        if (!toolRequests || !Array.isArray(toolRequests) || toolRequests.length === 0) {
          return {
            error: "Invalid execute_task call. Missing or empty 'tools' array.",
            hint: "Call execute_task with {task: 'description', tools: [{name: 'TOOL_NAME', source: 'local'}]}",
            receivedArgs: args,
          };
        }

        // Switch to SMART mode for task execution
        this.setMode("SMART");
        this.sendProgress(`🧠 Starting execution with ${toolRequests.length} tools...`);

        // Load the requested tools (using cache)
        const loadedTools: Array<ToolDefinition & { source: string; connectionId?: string }> = [];

        // Get cached connections to help find tools without connectionId
        const cachedConnections = await this.getConnections();
        const allCachedToolNames = cachedConnections.flatMap((c) => c.tools.map((t) => t.name));

        for (const req of toolRequests) {
          if (req.source === "local") {
            const tool = this.localTools.find((t) => t.name === req.name);
            if (tool) {
              loadedTools.push({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                source: "local",
              });
            }
          } else if (req.source === "mesh") {
            // Try to find connectionId if not provided
            let connectionId = req.connectionId;
            if (!connectionId) {
              // Search through cached connections to find which one has this tool
              const connWithTool = cachedConnections.find((c) =>
                c.tools.some((t) => t.name === req.name),
              );
              if (connWithTool) {
                connectionId = connWithTool.id;
              } else {
                // Tool not in any cached connection - LLM may have hallucinated
                // Find similar tool names to help debug
                const similarTools = allCachedToolNames.filter(
                  (name) =>
                    name.toLowerCase().includes(req.name.toLowerCase()) ||
                    req.name.toLowerCase().includes(name.toLowerCase().replace(/_/g, "")),
                );
                console.error(`[SMART] Tool "${req.name}" not found in any connection`);
                if (similarTools.length > 0) {
                  console.error(`[SMART] Did you mean: ${similarTools.join(", ")}?`);
                } else {
                  console.error(
                    `[SMART] Available tools: ${allCachedToolNames.slice(0, 15).join(", ")}...`,
                  );
                }
              }
            }

            if (connectionId) {
              // Use cached connection details for full schema
              const details = await this.getConnectionDetails(connectionId);
              if (details) {
                const tool = details.tools.find((t) => t.name === req.name);
                if (tool) {
                  loadedTools.push({
                    name: tool.name,
                    description: tool.description || "",
                    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                    source: "mesh",
                    connectionId,
                  });
                }
              }
            }
          }
        }

        // Log what we loaded vs what was requested
        if (loadedTools.length !== toolRequests.length) {
          console.error(
            `[SMART] Warning: Requested ${toolRequests.length} tools, loaded ${loadedTools.length}`,
          );
          console.error(`[SMART] Requested: ${toolRequests.map((t) => t.name).join(", ")}`);
        }

        // Run the executor with gathered context
        const result = await this.runExecutor(task, context, loadedTools, conversationHistory);

        // Return to FAST mode after execution
        this.setMode("FAST");

        return result;
      }

      default:
        return { error: `Unknown router tool: ${name}` };
    }
  }

  /**
   * Phase 2: Executor - Uses smart model with specific tools and gathered context
   */
  private async runExecutor(
    task: string,
    context: string | undefined,
    tools: Array<ToolDefinition & { source: string; connectionId?: string }>,
    conversationHistory: Message[],
  ): Promise<string> {
    const model = this.config.smartModel || this.config.fastModel;

    // Log executor start
    console.error(`\n[SMART] ─── Task: ${task.slice(0, 60)}${task.length > 60 ? "..." : ""}`);
    console.error(`[SMART] Available: ${tools.map((t) => t.name).join(", ")}`);
    if (context) {
      console.error(`[SMART] Context: ${context.length} chars`);
    }

    const allowedPaths =
      config.terminal.allowedPaths.length > 0
        ? config.terminal.allowedPaths.join(", ")
        : "/Users/guilherme/Projects/";

    // Build executor prompt with gathered context
    let executorPrompt = `You are a SMART EXECUTOR agent. You have been given a specific task and the tools to complete it.

**YOUR ROLE:**
You execute tasks step-by-step using the provided tools. You are capable, thorough, and complete the ENTIRE task before responding.

**TASK TO COMPLETE:**
${task}

**CRITICAL INSTRUCTIONS:**
1. FOLLOW THE PLAN: Execute each step in the task description
2. USE TOOLS: Call tools via the function calling API (never simulate with XML/markdown)
3. COMPLETE THE TASK: Don't stop until ALL steps are done
4. BE THOROUGH: For content creation, write actual content (not placeholders)
5. SUMMARIZE: After completing all steps, provide a brief summary

**CONTENT CREATION RULES:**
When creating articles, blog posts, or content:
- Write engaging, complete content (500-2000 words)
- Use the tone/style from any TONE_OF_VOICE context
- Include a compelling title
- Set status to "draft" unless told otherwise
- The article should be publication-ready

**FILE EXPLORATION:**
- Allowed paths: ${allowedPaths}
- Use LIST_FILES to see folder contents
- Use READ_FILE to read specific files
- Explore project structure before writing about it`;

    // Include gathered context if provided
    if (context) {
      executorPrompt += `

**CONTEXT FROM PLANNING PHASE:**
${context}`;
    }

    executorPrompt += `

**WORKFLOW:**
1. Execute each step in the task
2. If exploring files, read the most relevant ones
3. If creating content, write actual high-quality content
4. Call the creation/action tools with complete data
5. Respond with a brief summary of what you accomplished

Match user's language (Portuguese if they wrote in PT, English if EN).`;

    const messages: Message[] = [
      { role: "system", content: executorPrompt },
      ...conversationHistory.slice(-4),
      { role: "user", content: task },
    ];

    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    let successfulCreates = 0;
    let lastSuccessfulCreate: string | null = null;

    // Loop detection
    let lastToolCall: string | null = null;
    let consecutiveRepeats = 0;
    const MAX_CONSECUTIVE_REPEATS = 3;

    for (let i = 0; i < (this.config.maxExecutorIterations || 30); i++) {
      const result = await this.callLLM(model, messages, toolDefs);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // LLM finished - return its response
        const response = result.text || "Task completed.";
        this.sendProgress("✅ Done!");
        return response;
      }

      // Execute tool calls
      for (const tc of result.toolCalls) {
        // Loop detection: same tool called repeatedly
        const callSignature = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        if (callSignature === lastToolCall) {
          consecutiveRepeats++;
          if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
            console.error(`[SMART] ⚠️ Loop detected: ${tc.name} called ${consecutiveRepeats} times`);
            this.sendProgress(`⚠️ Stopped (loop detected)`);
            return `I got stuck in a loop calling ${tc.name}. The task may be partially complete.`;
          }
        } else {
          consecutiveRepeats = 1;
          lastToolCall = callSignature;
        }
        const toolDef = tools.find((t) => t.name === tc.name);
        if (!toolDef) {
          messages.push({ role: "user", content: `[Tool Error]: Unknown tool ${tc.name}` });
          continue;
        }

        // Format args for logging (compact, key names only for objects with many keys)
        const argsStr = this.formatArgsForLog(tc.arguments);

        // Get connection name for mesh tools
        let toolLabel = tc.name;
        if (toolDef.source === "mesh" && toolDef.connectionId) {
          const cachedConns = await this.getConnections();
          const conn = cachedConns.find((c) => c.id === toolDef.connectionId);
          if (conn) {
            toolLabel = `${conn.title}/${tc.name}`;
          }
        } else if (toolDef.source === "local") {
          toolLabel = `local/${tc.name}`;
        }
        console.error(`[SMART] → ${toolLabel}(${argsStr})`);

        // Track tool usage
        this.trackToolUsed(tc.name);

        // Send progress to UI
        const shortName = tc.name.replace("COLLECTION_", "").replace("_", " ");
        this.sendProgress(`⚡ ${shortName}...`);

        // Validate required parameters
        const schema = toolDef.inputSchema as {
          required?: string[];
          properties?: Record<string, unknown>;
        };
        const requiredParams = schema?.required || [];
        const missingParams = requiredParams.filter(
          (param) =>
            !(param in tc.arguments) ||
            tc.arguments[param] === undefined ||
            tc.arguments[param] === "",
        );

        if (missingParams.length > 0) {
          console.error(`[SMART] ✗ Missing: ${missingParams.join(", ")}`);
          messages.push({
            role: "assistant",
            content: `Calling ${tc.name}...`,
          });
          messages.push({
            role: "user",
            content: `[Tool Error for ${tc.name}]:\nMissing required parameters: ${missingParams.join(", ")}.\nYou MUST provide these values. For CREATE operations, generate the actual content.`,
          });
          continue;
        }

        let toolResult: unknown;
        const startTime = Date.now();

        try {
          if (toolDef.source === "local") {
            const localTool = this.localTools.find((t) => t.name === tc.name);
            if (localTool) {
              toolResult = await localTool.execute(tc.arguments);
            } else {
              toolResult = { error: "Local tool not found" };
            }
          } else if (toolDef.source === "mesh" && toolDef.connectionId) {
            const { callMeshTool } = await import("./mesh-client.ts");
            toolResult = await callMeshTool(toolDef.connectionId, tc.name, tc.arguments);
          } else {
            toolResult = { error: "Invalid tool configuration" };
          }

          const duration = Date.now() - startTime;
          const resultStr = this.formatResultForLog(toolResult);
          console.error(`[SMART] ✓ ${toolLabel} (${duration}ms) → ${resultStr}`);

          // Check if result contains an image - send it directly
          if (toolResult && typeof toolResult === "object") {
            const res = toolResult as Record<string, unknown>;
            // Check for image data URL (from our mesh-client extraction)
            if (res.image && typeof res.image === "string") {
              const imageUrl = res.image as string;
              console.error(
                `[SMART] 🖼️ Image detected (${imageUrl.length} chars), sending directly`,
              );
              this.sendProgress(`🖼️ Image generated!`);

              // Send image event to UI
              if (this.config.sendEvent) {
                this.config.sendEvent("image_generated", { imageUrl });
              }

              // Replace huge base64 with placeholder for LLM
              (toolResult as Record<string, unknown>).image = "[IMAGE DATA - sent to user]";
              (toolResult as Record<string, unknown>).imageSent = true;
            }
          }

          // Track successful CREATE operations
          if (tc.name.includes("CREATE") && toolResult && typeof toolResult === "object") {
            const res = toolResult as Record<string, unknown>;
            if (!res.error && (res.item || res.id || res.success)) {
              successfulCreates++;
              lastSuccessfulCreate = tc.name;
              this.sendProgress(`✅ Created successfully!`);

              // If we've done a CREATE, tell the LLM it's done
              if (successfulCreates >= 1) {
                messages.push({
                  role: "assistant",
                  content: `Calling ${tc.name}...`,
                });
                messages.push({
                  role: "user",
                  content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2).slice(0, 3000)}\n\n✅ SUCCESS! The task is complete. Please provide a brief summary to the user.`,
                });
                continue;
              }
            }
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(
            `[SMART] ✗ ${tc.name} (${duration}ms): ${error instanceof Error ? error.message : "Error"}`,
          );
          this.sendProgress(`❌ ${tc.name} failed`);
          toolResult = { error: error instanceof Error ? error.message : "Tool execution failed" };
        }

        messages.push({
          role: "assistant",
          content: result.text || `Calling ${tc.name}...`,
        });
        messages.push({
          role: "user",
          content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2).slice(0, 3000)}`,
        });
      }
    }

    this.sendProgress("⚠️ Reached iteration limit");
    if (lastSuccessfulCreate) {
      return `Task completed (${lastSuccessfulCreate} was successful), but the AI didn't provide a summary.`;
    }
    return "Task execution reached iteration limit without completing.";
  }

  /**
   * Call the LLM with tools
   */
  private async callLLM(
    modelId: string,
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<{
    text?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }> {
    const { callMeshTool, getLLMConnectionId } = await import("./mesh-client.ts");

    const llmConnectionId = getLLMConnectionId();
    if (!llmConnectionId) {
      throw new Error("LLM binding not configured");
    }

    const prompt = messages.map((m) => {
      if (m.role === "system") {
        return { role: "system", content: m.content };
      }
      return {
        role: m.role,
        content: [{ type: "text", text: m.content }],
      };
    });

    const toolsForLLM = tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));

    const callOptions = {
      prompt,
      tools: toolsForLLM.length > 0 ? toolsForLLM : undefined,
      toolChoice: toolsForLLM.length > 0 ? { type: "auto" as const } : undefined,
      maxOutputTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    const result = await callMeshTool<{
      content?: Array<{
        type: string;
        text?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        input?: string | Record<string, unknown>;
      }>;
      text?: string;
      finishReason?: string;
    }>(llmConnectionId, "LLM_DO_GENERATE", { modelId, callOptions });

    // Extract text
    let text: string | undefined;
    if (result?.content) {
      const textPart = result.content.find((c) => c.type === "text");
      if (textPart?.text) text = textPart.text;
    }
    if (!text && result?.text) text = result.text;

    // Extract tool calls
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const toolCallParts = result?.content?.filter((c) => c.type === "tool-call") || [];

    for (const tc of toolCallParts) {
      let parsedArgs: Record<string, unknown> = {};
      if (tc.args && typeof tc.args === "object") {
        parsedArgs = tc.args;
      } else if (tc.input) {
        if (typeof tc.input === "string") {
          try {
            parsedArgs = JSON.parse(tc.input);
          } catch {
            // Ignore parse errors - use empty args
          }
        } else {
          parsedArgs = tc.input;
        }
      }

      if (tc.toolName) {
        toolCalls.push({ name: tc.toolName, arguments: parsedArgs });
      }
    }

    return { text, toolCalls };
  }
}
