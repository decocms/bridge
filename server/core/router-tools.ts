/**
 * Router Meta-Tools
 *
 * These tools are used by the FAST router phase to:
 * 1. Discover available tools (local + mesh)
 * 2. Explore files for context
 * 3. Create execution plans for the SMART phase
 *
 * Extracted from agent.ts for cleaner separation.
 */

import type { LocalTool } from "./agent.ts";
import type { MeshClient, ToolDefinition } from "./mesh-client.ts";
import { callMeshTool, getConnectionBindingId, cacheConnectionName } from "./mesh-client.ts";
import { config } from "../config.ts";

// ============================================================================
// Types
// ============================================================================

export interface ConnectionInfo {
  id: string;
  title: string;
  toolCount: number;
  tools: Array<{ name: string; description?: string }>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: "local" | "mesh";
  connectionId?: string;
}

export interface ExecutionPlan {
  task: string;
  context?: string;
  tools: Array<{
    name: string;
    source: "local" | "mesh";
    connectionId?: string;
  }>;
}

// ============================================================================
// Connection Cache
// ============================================================================

interface ConnectionCache {
  connections: ConnectionInfo[] | null;
  lastFetched: number;
}

const connectionCache: ConnectionCache = {
  connections: null,
  lastFetched: 0,
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached connections, fetching if stale
 */
export async function getConnections(meshClient: MeshClient): Promise<ConnectionInfo[]> {
  const now = Date.now();

  if (connectionCache.connections && now - connectionCache.lastFetched < CACHE_TTL) {
    return connectionCache.connections;
  }

  try {
    const connections = await meshClient.listConnections();
    connectionCache.connections = connections;
    connectionCache.lastFetched = now;

    // Cache names for logging
    for (const conn of connections) {
      cacheConnectionName(conn.id, conn.title);
    }

    return connections;
  } catch {
    return connectionCache.connections || [];
  }
}

/**
 * Invalidate the connection cache
 */
export function invalidateConnectionCache(): void {
  connectionCache.connections = null;
  connectionCache.lastFetched = 0;
}

// ============================================================================
// Schema Cache
// ============================================================================

const schemaCache = new Map<
  string,
  { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
>();

/**
 * Get connection details with full tool schemas
 */
export async function getConnectionDetails(
  connectionId: string,
): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> } | null> {
  if (schemaCache.has(connectionId)) {
    return schemaCache.get(connectionId)!;
  }

  try {
    const connBindingId = getConnectionBindingId();
    if (!connBindingId) return null;

    const result = await callMeshTool<{
      item?: {
        id: string;
        title: string;
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      };
    }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

    const conn = result?.item;
    const details = { tools: conn?.tools || [] };
    schemaCache.set(connectionId, details);
    return details;
  } catch {
    return null;
  }
}

// ============================================================================
// Router System Prompt
// ============================================================================

export function getRouterSystemPrompt(): string {
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

**RULES:**
- Simple questions → respond directly (no tools)
- "List tools" requests → call list_mesh_tools, respond with results
- Complex tasks → explore files, gather context, then execute_task
- Include gathered file contents in the context field!
- Match user's language (PT/EN)

**File System Access:** ${allowedPaths}`;
}

// ============================================================================
// Router Tools Factory
// ============================================================================

export function createRouterTools(
  localTools: LocalTool[],
  meshClient: MeshClient,
  onExecuteTask: (plan: ExecutionPlan) => Promise<string>,
  sendProgress: (msg: string) => void,
  previousTools: string[],
): ToolDefinition[] {
  const allowedPaths =
    config.terminal.allowedPaths.length > 0
      ? config.terminal.allowedPaths.join(", ")
      : "/Users/guilherme/Projects/";

  return [
    {
      name: "list_local_tools",
      description: "List available local system tools (files, shell, notifications, speech, etc.)",
      inputSchema: { type: "object", properties: {} },
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
          path: { type: "string", description: "File path to read" },
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
// Router Tool Execution
// ============================================================================

export interface RouterToolContext {
  localTools: LocalTool[];
  meshClient: MeshClient;
  sendProgress: (msg: string) => void;
  previousTools: string[];
  onExecuteTask: (plan: ExecutionPlan) => Promise<string>;
}

export async function executeRouterTool(
  name: string,
  args: Record<string, unknown>,
  ctx: RouterToolContext,
): Promise<unknown> {
  const { localTools, meshClient, sendProgress, previousTools, onExecuteTask } = ctx;

  switch (name) {
    case "list_local_tools": {
      const tools = localTools.map((t) => ({
        name: t.name,
        description: t.description.slice(0, 100) + (t.description.length > 100 ? "..." : ""),
        source: "local",
      }));
      sendProgress(`📦 Found ${tools.length} local tools`);
      return { tools, count: tools.length };
    }

    case "explore_files": {
      const path = args.path as string;
      if (!path) return { error: "Missing 'path' parameter" };

      const listFilesTool = localTools.find((t) => t.name === "LIST_FILES");
      if (!listFilesTool) return { error: "LIST_FILES tool not available" };

      try {
        const result = (await listFilesTool.execute({ path })) as {
          content?: Array<{ text?: string }>;
        };
        if (result?.content?.[0]?.text) {
          const parsed = JSON.parse(result.content[0].text);
          sendProgress(`📂 Found ${parsed.count || 0} items in ${path.split("/").pop()}`);
          return {
            path: parsed.path,
            files: parsed.files?.slice(0, 30),
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
      if (!path) return { error: "Missing 'path' parameter" };

      const readFileTool = localTools.find((t) => t.name === "READ_FILE");
      if (!readFileTool) return { error: "READ_FILE tool not available" };

      try {
        const result = (await readFileTool.execute({ path, limit: 200 })) as {
          content?: Array<{ text?: string }>;
        };
        if (result?.content?.[0]?.text) {
          const parsed = JSON.parse(result.content[0].text);
          sendProgress(`📄 Read ${parsed.path?.split("/").pop() || path}`);
          return {
            path: parsed.path,
            preview: parsed.content?.slice(0, 3000),
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
        const connections = await getConnections(meshClient);

        if (connectionId) {
          const conn = connections.find((c) => c.id === connectionId);
          if (!conn) return { error: `Connection not found: ${connectionId}` };

          const tools = conn.tools.map((t) => ({
            name: t.name,
            description: (t.description || "").slice(0, 100),
            source: "mesh",
            connectionId,
          }));
          return { tools, count: tools.length, connectionId, connectionName: conn.title };
        } else {
          const allTools = connections.flatMap((c) =>
            c.tools.map((t) => ({
              name: t.name,
              description: (t.description || "").slice(0, 150),
              connectionId: c.id,
              connectionName: c.title,
            })),
          );

          sendProgress(
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
        | Array<{ name: string; source: string; connectionId?: string }>
        | undefined;

      if (!toolRequests || !Array.isArray(toolRequests) || toolRequests.length === 0) {
        return {
          error: "Missing 'tools' array in get_tool_schemas call.",
          hint: "Call with {tools: [{name: 'TOOL_NAME', source: 'mesh', connectionId: '...'}]}",
        };
      }

      const schemas: ToolSchema[] = [];
      const cachedConnections = await getConnections(meshClient);

      for (const req of toolRequests) {
        if (req.source === "local") {
          const tool = localTools.find((t) => t.name === req.name);
          if (tool) {
            schemas.push({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              source: "local",
            });
          }
        } else if (req.source === "mesh") {
          let connectionId = req.connectionId;
          if (!connectionId) {
            const connWithTool = cachedConnections.find((c) =>
              c.tools.some((t) => t.name === req.name),
            );
            if (connWithTool) connectionId = connWithTool.id;
          }

          if (connectionId) {
            const details = await getConnectionDetails(connectionId);
            const tool = details?.tools.find((t) => t.name === req.name);
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
        }
      }

      return { schemas, count: schemas.length };
    }

    case "execute_task": {
      const task = args.task as string | undefined;
      const context = args.context as string | undefined;
      const toolRequests = args.tools as
        | Array<{ name: string; source: string; connectionId?: string }>
        | undefined;

      // Enforce workflow
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

      if (!task || typeof task !== "string") {
        return {
          error: "Invalid execute_task call. Missing 'task' field.",
          hint: "Call execute_task with {task: 'description', context: 'gathered info', tools: [...]}",
        };
      }

      if (!toolRequests || !Array.isArray(toolRequests) || toolRequests.length === 0) {
        return {
          error: "Invalid execute_task call. Missing or empty 'tools' array.",
          hint: "Call execute_task with {task: 'description', tools: [{name: 'TOOL_NAME', source: 'local'}]}",
        };
      }

      sendProgress(`🧠 Starting execution with ${toolRequests.length} tools...`);

      // Map to correct type and execute via callback
      const typedTools = toolRequests.map((t) => ({
        name: t.name,
        source: t.source as "local" | "mesh",
        connectionId: t.connectionId,
      }));

      return await onExecuteTask({ task, context, tools: typedTools });
    }

    default:
      return { error: `Unknown router tool: ${name}` };
  }
}
