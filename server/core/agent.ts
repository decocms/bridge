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
}

// Connection cache - shared across agent instances for the session
interface ConnectionCache {
  connections: Array<{ id: string; title: string; toolCount: number }> | null;
  connectionDetails: Map<
    string,
    { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
  >;
  lastFetched: number;
}

const connectionCache: ConnectionCache = {
  connections: null,
  connectionDetails: new Map(),
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

  return `You are an AI assistant with access to tools. You operate in two phases:

**Phase 1 (Current):** You have 4 meta-tools to discover and select tools:
- list_local_tools: See what local system tools are available (files, shell, notifications, etc.)
- list_mesh_tools: See what MCP mesh tools are available (external services)
- get_tool_schemas: Get full details for specific tools before using them
- execute_task: Run a task with selected tools

**Your job:** Understand what the user wants, find the right tools, then call execute_task.

**File System Access:**
- Allowed paths: ${allowedPaths}
- When working with files, always use full paths within these directories

**Rules:**
- For simple questions, just respond directly (no tools needed)
- For tasks requiring tools, first list available tools, then get schemas, then execute
- Keep responses SHORT
- Match user's language (PT/EN)`;
}

function createRouterTools(localTools: LocalTool[], meshClient: MeshClient): ToolDefinition[] {
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
        "List available MCP mesh tools from external connections (APIs, databases, etc.)",
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
      description: `Execute a task with specific tools. Example call:
{
  "task": "Read the README.md file and summarize it",
  "tools": [{"name": "READ_FILE", "source": "local"}]
}
You MUST provide both "task" (string describing what to do) and "tools" (array of tool objects with name and source).`,
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Natural language description of what to do (e.g., 'Read the README.md file')",
          },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Tool name from list_local_tools or list_mesh_tools",
                },
                source: { type: "string", enum: ["local", "mesh"], description: "local or mesh" },
                connectionId: { type: "string", description: "Required for mesh tools only" },
              },
              required: ["name", "source"],
            },
            description:
              'Array of tools to load. Example: [{"name": "READ_FILE", "source": "local"}]',
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

  constructor(meshClient: MeshClient, localTools: LocalTool[], config: AgentConfig) {
    this.meshClient = meshClient;
    this.localTools = localTools;
    this.config = {
      maxTokens: 2048,
      temperature: 0.7,
      maxRouterIterations: 3,
      maxExecutorIterations: 5,
      ...config,
    };
  }

  /**
   * Set the current agent mode and notify callback
   */
  private setMode(mode: "FAST" | "SMART"): void {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
      console.error(`[Agent] Mode changed to: ${mode}`);
      this.config.onModeChange?.(mode);
    }
  }

  /**
   * Get cached connections, fetching if needed
   */
  private async getConnections(): Promise<Array<{ id: string; title: string; toolCount: number }>> {
    const now = Date.now();

    // Return cached if fresh
    if (connectionCache.connections && now - connectionCache.lastFetched < CACHE_TTL) {
      console.error(`[Agent] Using cached connections (${connectionCache.connections.length})`);
      return connectionCache.connections;
    }

    // Fetch fresh
    console.error(`[Agent] Fetching connections from mesh...`);
    try {
      const connections = await this.meshClient.listConnections();
      connectionCache.connections = connections;
      connectionCache.lastFetched = now;
      console.error(`[Agent] Cached ${connections.length} connections`);
      return connections;
    } catch (error) {
      console.error(`[Agent] Failed to fetch connections:`, error);
      return connectionCache.connections || [];
    }
  }

  /**
   * Get cached connection details, fetching if needed
   */
  private async getConnectionDetails(connectionId: string): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  } | null> {
    // Check cache first
    if (connectionCache.connectionDetails.has(connectionId)) {
      console.error(`[Agent] Using cached details for ${connectionId}`);
      return connectionCache.connectionDetails.get(connectionId)!;
    }

    // Fetch from mesh
    console.error(`[Agent] Fetching details for connection ${connectionId}...`);
    try {
      const { callMeshTool, getConnectionBindingId } = await import("./mesh-client.ts");
      const connBindingId = getConnectionBindingId();
      if (!connBindingId) return null;

      const conn = await callMeshTool<{
        id: string;
        title: string;
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

      const details = { tools: conn?.tools || [] };
      connectionCache.connectionDetails.set(connectionId, details);
      console.error(`[Agent] Cached ${details.tools.length} tools for ${connectionId}`);
      return details;
    } catch (error) {
      console.error(`[Agent] Failed to fetch connection details:`, error);
      return null;
    }
  }

  /**
   * Run the agent on a user message
   */
  async run(userMessage: string, conversationHistory: Message[] = []): Promise<string> {
    console.error(`\n[Agent] ========== NEW REQUEST ==========`);
    console.error(`[Agent] User: "${userMessage.slice(0, 100)}..."`);
    console.error(`[Agent] Fast model: ${this.config.fastModel}`);
    console.error(`[Agent] Smart model: ${this.config.smartModel || "(same as fast)"}`);

    // Start in FAST mode
    this.setMode("FAST");

    // Phase 1: Router
    return this.runRouter(userMessage, conversationHistory);
  }

  /**
   * Phase 1: Router - Uses fast model with 4 meta-tools
   */
  private async runRouter(userMessage: string, conversationHistory: Message[]): Promise<string> {
    console.error(`[Agent] Phase 1: ROUTER`);

    const messages: Message[] = [
      { role: "system", content: getRouterSystemPrompt() },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ];

    const routerTools = createRouterTools(this.localTools, this.meshClient);

    for (let i = 0; i < (this.config.maxRouterIterations || 3); i++) {
      console.error(`[Agent] Router iteration ${i + 1}/${this.config.maxRouterIterations}`);

      const result = await this.callLLM(this.config.fastModel, messages, routerTools);

      // If no tool calls, return the response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        console.error(`[Agent] Router: No tool calls, returning response`);
        return result.text || "I couldn't generate a response.";
      }

      // Process tool calls
      for (const tc of result.toolCalls) {
        console.error(`[Agent] Router tool call: ${tc.name}`);
        const toolResult = await this.executeRouterTool(
          tc.name,
          tc.arguments,
          userMessage,
          conversationHistory,
        );

        // If execute_task was called, it returns the final response
        if (tc.name === "execute_task" && typeof toolResult === "string") {
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
  ): Promise<unknown> {
    console.error(`\n[Agent] Router executing: ${name}`);
    console.error(`[Agent] Args: ${JSON.stringify(args)}`);

    switch (name) {
      case "list_local_tools": {
        const tools = this.localTools.map((t) => ({
          name: t.name,
          description: t.description.slice(0, 100) + (t.description.length > 100 ? "..." : ""),
          source: "local",
        }));
        console.error(`[Agent] Listed ${tools.length} local tools`);
        return { tools, count: tools.length };
      }

      case "list_mesh_tools": {
        const connectionId = args.connectionId as string | undefined;
        try {
          if (connectionId) {
            // List tools from specific connection (cached)
            const details = await this.getConnectionDetails(connectionId);
            if (!details) {
              return { error: "CONNECTION binding not configured or connection not found" };
            }

            const tools = details.tools.map((t) => ({
              name: t.name,
              description: (t.description || "").slice(0, 100),
              source: "mesh",
              connectionId,
            }));
            return { tools, count: tools.length, connectionId };
          } else {
            // List all connections with tool counts (cached)
            const connections = await this.getConnections();
            return {
              connections: connections.map((c) => ({
                id: c.id,
                name: c.title,
                toolCount: c.toolCount,
              })),
              count: connections.length,
              hint: "Use list_mesh_tools with connectionId to see tools from a specific connection",
            };
          }
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Failed to list mesh tools" };
        }
      }

      case "get_tool_schemas": {
        const toolRequests = args.tools as Array<{
          name: string;
          source: string;
          connectionId?: string;
        }>;
        const schemas: ToolSchema[] = [];

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
          } else if (req.source === "mesh" && req.connectionId) {
            try {
              const { callMeshTool, getConnectionBindingId } = await import("./mesh-client.ts");
              const connBindingId = getConnectionBindingId();
              if (connBindingId) {
                const conn = await callMeshTool<{
                  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
                }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: req.connectionId });

                const tool = conn?.tools?.find((t) => t.name === req.name);
                if (tool) {
                  schemas.push({
                    name: tool.name,
                    description: tool.description || "",
                    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                    source: "mesh",
                    connectionId: req.connectionId,
                  });
                }
              }
            } catch (error) {
              console.error(`[Agent] Failed to get schema for ${req.name}:`, error);
            }
          }
        }

        console.error(`[Agent] Got ${schemas.length} tool schemas`);
        return { schemas, count: schemas.length };
      }

      case "execute_task": {
        const task = args.task as string | undefined;
        const toolRequests = args.tools as
          | Array<{
              name: string;
              source: string;
              connectionId?: string;
            }>
          | undefined;

        // Validate required fields - LLM sometimes hallucinates wrong schema
        if (!task || typeof task !== "string") {
          console.error(`[Agent] execute_task called with invalid task:`, args);
          return {
            error: "Invalid execute_task call. Missing 'task' field.",
            hint: "Call execute_task with {task: 'description', tools: [{name: 'TOOL_NAME', source: 'local'}]}",
            receivedArgs: args,
          };
        }

        if (!toolRequests || !Array.isArray(toolRequests) || toolRequests.length === 0) {
          console.error(`[Agent] execute_task called with invalid tools:`, args);
          return {
            error: "Invalid execute_task call. Missing or empty 'tools' array.",
            hint: "Call execute_task with {task: 'description', tools: [{name: 'TOOL_NAME', source: 'local'}]}",
            receivedArgs: args,
          };
        }

        // Switch to SMART mode for task execution
        this.setMode("SMART");

        console.error(`[Agent] Phase 2: EXECUTOR`);
        console.error(`[Agent] Task: "${task}"`);
        console.error(`[Agent] Tools requested: ${toolRequests.map((t) => t.name).join(", ")}`);

        // Load the requested tools (using cache)
        const loadedTools: Array<ToolDefinition & { source: string; connectionId?: string }> = [];

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
          } else if (req.source === "mesh" && req.connectionId) {
            // Use cached connection details
            const details = await this.getConnectionDetails(req.connectionId);
            if (details) {
              const tool = details.tools.find((t) => t.name === req.name);
              if (tool) {
                loadedTools.push({
                  name: tool.name,
                  description: tool.description || "",
                  inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                  source: "mesh",
                  connectionId: req.connectionId,
                });
              }
            }
          }
        }

        console.error(`[Agent] Loaded ${loadedTools.length} tools for execution`);

        // Run the executor
        const result = await this.runExecutor(task, loadedTools, conversationHistory);

        // Return to FAST mode after execution
        this.setMode("FAST");

        return result;
      }

      default:
        return { error: `Unknown router tool: ${name}` };
    }
  }

  /**
   * Phase 2: Executor - Uses smart model with specific tools
   */
  private async runExecutor(
    task: string,
    tools: Array<ToolDefinition & { source: string; connectionId?: string }>,
    conversationHistory: Message[],
  ): Promise<string> {
    const model = this.config.smartModel || this.config.fastModel;
    console.error(`[Agent] Executor using model: ${model}`);
    console.error(
      `[Agent] Executor has ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
    );

    const allowedPaths =
      config.terminal.allowedPaths.length > 0
        ? config.terminal.allowedPaths.join(", ")
        : "/Users/guilherme/Projects/";

    const executorPrompt = `You are executing a specific task. You have been given specific tools to use.

Task: ${task}

**File System Access:**
- Allowed paths: ${allowedPaths}
- When working with files, always use full paths within these directories

Use the available tools to complete this task. Be concise in your response.`;

    const messages: Message[] = [
      { role: "system", content: executorPrompt },
      ...conversationHistory.slice(-4), // Keep some context but not too much
      { role: "user", content: task },
    ];

    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    for (let i = 0; i < (this.config.maxExecutorIterations || 5); i++) {
      console.error(`[Agent] Executor iteration ${i + 1}/${this.config.maxExecutorIterations}`);

      const result = await this.callLLM(model, messages, toolDefs);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        console.error(`[Agent] Executor: No tool calls, returning response`);
        return result.text || "Task completed.";
      }

      // Execute tool calls
      for (const tc of result.toolCalls) {
        const toolDef = tools.find((t) => t.name === tc.name);
        if (!toolDef) {
          messages.push({ role: "user", content: `[Tool Error]: Unknown tool ${tc.name}` });
          continue;
        }

        console.error(`\n[Agent] Executor tool call: ${tc.name}`);
        console.error(`[Agent] Args: ${JSON.stringify(tc.arguments, null, 2)}`);

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
          console.error(`[Agent] ✓ ${tc.name} completed in ${duration}ms`);
          console.error(`[Agent] Result: ${JSON.stringify(toolResult).slice(0, 500)}`);
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(`[Agent] ✗ ${tc.name} failed in ${duration}ms:`, error);
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

    return "Task execution reached iteration limit.";
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

    console.error(`[Agent] Calling LLM: ${modelId} with ${toolsForLLM.length} tools`);

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
            console.error(`[Agent] Failed to parse tool input`);
          }
        } else {
          parsedArgs = tc.input;
        }
      }

      if (tc.toolName) {
        toolCalls.push({ name: tc.toolName, arguments: parsedArgs });
      }
    }

    console.error(`[Agent] LLM response: text=${!!text}, toolCalls=${toolCalls.length}`);

    return { text, toolCalls };
  }
}
