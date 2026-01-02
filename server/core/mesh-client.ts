/**
 * Mesh Client
 *
 * Connects to the local MCP Mesh and uses bindings to access tools.
 * Supports two modes:
 *
 * 1. **Standalone mode**: mesh-bridge runs separately, calls mesh with MESH_API_KEY
 * 2. **Mesh-hosted mode**: mesh-bridge runs as STDIO MCP, gets token from MESH_REQUEST_CONTEXT
 */

import { config } from "../config.ts";

export interface MCPConnection {
  type: "HTTP";
  url: string;
  token?: string;
  headers?: Record<string, string>;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Binding value from Mesh UI
 */
interface BindingValue {
  __type: string;
  value: string;
}

/**
 * MESH_REQUEST_CONTEXT is provided by the mesh when running as a hosted MCP.
 * This gives us the authorization token to call other mesh tools.
 */
export interface MeshRequestContext {
  authorization?: string;
  state?: Record<string, unknown>;
  meshUrl?: string;
}

// Global context - set when running inside mesh
let meshRequestContext: MeshRequestContext | null = null;

/**
 * Set the mesh request context (called by runtime when running inside mesh)
 */
export function setMeshRequestContext(ctx: MeshRequestContext): void {
  meshRequestContext = ctx;
  // Use console.error since stdout is for MCP protocol
  console.error("[mesh-bridge] Mesh context updated, hasToken:", !!ctx.authorization);
}

/**
 * Get the mesh URL from context or config
 */
export function getMeshUrl(): string {
  return meshRequestContext?.meshUrl || config.mesh.url || "http://localhost:3000";
}

/**
 * Get the authorization token for mesh calls.
 * Priority: MESH_REQUEST_CONTEXT > MESH_API_KEY env var
 */
function getAuthToken(): string | undefined {
  // If running inside mesh, use the provided context
  if (meshRequestContext?.authorization) {
    return meshRequestContext.authorization;
  }

  // Fall back to env var for standalone mode
  return config.mesh.apiKey || undefined;
}

/**
 * Check if mesh is ready (has received configuration from mesh)
 */
export function isMeshReady(): boolean {
  return meshRequestContext !== null && !!meshRequestContext.authorization;
}

/**
 * Get a binding connection ID from state by name
 */
function getBindingConnectionId(bindingName: string): string | undefined {
  if (!meshRequestContext) {
    console.error(
      `[getBindingConnectionId:${bindingName}] meshRequestContext is null - ON_MCP_CONFIGURATION not called yet`,
    );
    return undefined;
  }
  if (!meshRequestContext.state) {
    console.error(`[getBindingConnectionId:${bindingName}] meshRequestContext.state is undefined`);
    return undefined;
  }
  const binding = meshRequestContext.state[bindingName] as BindingValue | undefined;
  if (!binding) {
    console.error(
      `[getBindingConnectionId:${bindingName}] Binding not in state. Available keys:`,
      Object.keys(meshRequestContext.state),
    );
    return undefined;
  }
  console.error(`[getBindingConnectionId:${bindingName}] Found binding:`, binding.value);
  return binding.value;
}

/**
 * Get the LLM binding connection ID from state
 */
export function getLLMConnectionId(): string | undefined {
  return getBindingConnectionId("LLM");
}

/**
 * Get the CONNECTION binding connection ID from state
 * This is the mesh's connection management binding
 */
export function getConnectionBindingId(): string | undefined {
  return getBindingConnectionId("CONNECTION");
}

/**
 * Get the DATABASE binding connection ID from state
 */
export function getDatabaseBindingId(): string | undefined {
  return getBindingConnectionId("DATABASE");
}

/**
 * Get the EVENT_BUS binding connection ID from state
 */
export function getEventBusBindingId(): string | undefined {
  return getBindingConnectionId("EVENT_BUS");
}

/**
 * Call a tool on a specific Mesh connection via the proxy API.
 * This allows STDIO MCPs to use bindings just like HTTP MCPs.
 */
export async function callMeshTool<T = unknown>(
  connectionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const token = getAuthToken();
  const meshUrl = getMeshUrl();

  if (!token) {
    throw new Error("Mesh not configured. Configure bindings in Mesh UI first.");
  }

  const endpoint = `${meshUrl}/mcp/${connectionId}`;
  console.error(`\n[callMeshTool] ──────────────────────────────────────`);
  console.error(`[callMeshTool] → ${toolName} @ ${connectionId}`);
  console.error(`[callMeshTool] Args: ${JSON.stringify(args, null, 2)}`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[callMeshTool] Error response (${response.status}): ${text}`);

    if (response.status === 401) {
      console.error(
        `[callMeshTool] ⚠️ TOKEN EXPIRED - Mesh should send ON_MCP_CONFIGURATION with fresh token`,
      );
      console.error(`[callMeshTool] This usually means the mesh connection needs to be restarted.`);
      throw new Error(`Token expired (401). Restart mesh connection to get fresh credentials.`);
    }

    throw new Error(`Mesh API error (${response.status}): ${text}`);
  }

  // Handle both JSON and SSE responses
  const contentType = response.headers.get("Content-Type") || "";
  console.error(`[callMeshTool] Response Content-Type: ${contentType}`);

  let json: {
    result?: { structuredContent?: T; content?: { text: string }[] };
    error?: { message: string };
  };

  if (contentType.includes("text/event-stream")) {
    // Parse SSE response - extract JSON from data lines
    const text = await response.text();
    console.error(`[callMeshTool] SSE response (first 500 chars): ${text.slice(0, 500)}`);
    const lines = text.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    const lastData = dataLines[dataLines.length - 1];
    if (!lastData) {
      throw new Error("Empty SSE response from Mesh API");
    }
    try {
      json = JSON.parse(lastData.slice(6)); // Remove "data: " prefix
    } catch (parseError) {
      console.error(`[callMeshTool] Failed to parse SSE data: ${lastData.slice(6).slice(0, 200)}`);
      throw parseError;
    }
  } else {
    const text = await response.text();
    console.error(`[callMeshTool] JSON response (first 500 chars): ${text.slice(0, 500)}`);
    try {
      json = JSON.parse(text);
    } catch (parseError) {
      console.error(`[callMeshTool] Failed to parse JSON: ${text.slice(0, 200)}`);
      throw parseError;
    }
  }

  if (json.error) {
    throw new Error(`Mesh tool error: ${json.error.message}`);
  }

  // Check if result contains an error in the text content
  const textContent = json.result?.content?.[0]?.text;
  if (textContent?.startsWith("MCP error")) {
    throw new Error(textContent);
  }

  // Return structured content if available, otherwise try to parse text
  if (json.result?.structuredContent) {
    return json.result.structuredContent as T;
  }

  if (textContent) {
    try {
      return JSON.parse(textContent) as T;
    } catch {
      // If it's not JSON, return the text wrapped
      return { text: textContent } as T;
    }
  }

  return null as T;
}

/**
 * MCP Mesh client for calling tools
 *
 * Uses the proper MCP JSON-RPC protocol:
 * 1. Initialize session
 * 2. List tools / Call tools
 */
export class MeshClient {
  private connection: MCPConnection;
  private initialized: boolean = false;

  constructor(meshUrl: string, token?: string) {
    this.connection = {
      type: "HTTP",
      url: meshUrl,
      token,
    };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // Dynamic token resolution - check context first
    const token = getAuthToken() || this.connection.token;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    return headers;
  }

  private getMcpUrl(): string {
    const url = new URL(this.connection.url);
    url.pathname = `/mcp`;
    return url.href;
  }

  /**
   * Initialize the MCP session (required before calling tools)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const response = await fetch(this.getMcpUrl(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "mesh-bridge",
            version: "1.0.0",
          },
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MCP initialization failed: ${response.status} ${error}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(`MCP init error: ${result.error.message}`);
    }

    this.initialized = true;
  }

  /**
   * Call a tool on the mesh
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();

    const url = this.getMcpUrl();
    console.error(`[MeshClient] callTool ${name} -> ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(
        `[MeshClient] callTool ${name} failed: ${response.status}`,
        error.slice(0, 200),
      );
      throw new Error(`Mesh call failed: ${response.status} ${error}`);
    }

    const result = await response.json();
    console.error(
      `[MeshClient] callTool ${name} raw result:`,
      JSON.stringify(result).slice(0, 300),
    );

    if (result.error) {
      throw new Error(`Tool error: ${result.error.message}`);
    }

    // Extract content from result
    const content = result.result;

    if (content?.structuredContent) {
      console.error(`[MeshClient] callTool ${name} -> structuredContent`);
      return content.structuredContent;
    }

    if (content?.content?.[0]?.text) {
      console.error(`[MeshClient] callTool ${name} -> content[0].text`);
      try {
        return JSON.parse(content.content[0].text);
      } catch {
        return content.content[0].text;
      }
    }

    console.error(`[MeshClient] callTool ${name} -> raw content`);
    return content;
  }

  /**
   * List available tools from all connections in the mesh.
   * Uses the CONNECTION binding's COLLECTION_CONNECTIONS_LIST tool.
   */
  async listTools(): Promise<
    Array<{ name: string; description?: string; connectionId?: string; connectionTitle?: string }>
  > {
    await this.initialize();

    // Use the CONNECTION binding to list all connections with their tools
    const connectionBindingId = getConnectionBindingId();

    if (connectionBindingId) {
      try {
        console.error("[MeshClient] Listing tools via CONNECTION binding...");
        const result = await callMeshTool<{
          items?: Array<{
            id: string;
            title: string;
            tools?: Array<{ name: string; description?: string }>;
          }>;
        }>(connectionBindingId, "COLLECTION_CONNECTIONS_LIST", {});

        const allTools: Array<{
          name: string;
          description?: string;
          connectionId?: string;
          connectionTitle?: string;
        }> = [];

        for (const conn of result?.items || []) {
          for (const tool of conn.tools || []) {
            allTools.push({
              name: tool.name,
              description: tool.description,
              connectionId: conn.id,
              connectionTitle: conn.title,
            });
          }
        }

        console.error(
          `[MeshClient] Found ${allTools.length} tools from ${result?.items?.length || 0} connections`,
        );
        return allTools;
      } catch (error) {
        console.error("[MeshClient] Failed to list via CONNECTION binding:", error);
        // Fall through to legacy method
      }
    }

    // Legacy fallback: call /mcp tools/list directly
    console.error("[MeshClient] Falling back to direct /mcp tools/list...");
    const response = await fetch(this.getMcpUrl(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/list",
        params: {},
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to list tools: ${response.status}`);
    }

    const result = await response.json();
    return result.result?.tools || [];
  }

  /**
   * List all connections in the mesh
   */
  async listConnections(): Promise<Array<{ id: string; title: string; toolCount: number }>> {
    const connectionBindingId = getConnectionBindingId();

    if (!connectionBindingId) {
      console.error("[MeshClient] CONNECTION binding not configured");
      return [];
    }

    try {
      const result = await callMeshTool<{
        items?: Array<{
          id: string;
          title: string;
          tools?: Array<{ name: string }>;
        }>;
      }>(connectionBindingId, "COLLECTION_CONNECTIONS_LIST", {});

      return (result?.items || []).map((conn) => ({
        id: conn.id,
        title: conn.title,
        toolCount: conn.tools?.length || 0,
      }));
    } catch (error) {
      console.error("[MeshClient] Failed to list connections:", error);
      return [];
    }
  }

  /**
   * Call a tool on a specific connection
   */
  async callConnectionTool(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return callMeshTool(connectionId, toolName, args);
  }

  /**
   * Call LLM_DO_GENERATE to generate a response using the mesh's LLM binding.
   * Routes through the bound LLM connection (e.g., OpenRouter).
   */
  async generateWithLLM(
    modelId: string,
    messages: Message[],
    options: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string> {
    // Get the LLM connection ID from bindings
    const llmConnectionId = getLLMConnectionId();
    if (!llmConnectionId) {
      throw new Error("LLM binding not configured. Configure the LLM binding in Mesh UI first.");
    }

    console.error(`[MeshClient] Using LLM connection: ${llmConnectionId}`);

    // Convert messages to the format expected by LLM_DO_GENERATE
    // System messages: content is a string
    // User/Assistant messages: content is an array of parts [{type: "text", text: "..."}]
    const prompt = messages.map((m) => {
      if (m.role === "system") {
        return { role: "system", content: m.content };
      }
      return {
        role: m.role,
        content: [{ type: "text", text: m.content }],
      };
    });

    const callOptions = {
      prompt,
      mode: { type: "regular" },
      ...(options.maxTokens && { maxTokens: options.maxTokens }),
      ...(options.temperature && { temperature: options.temperature }),
    };

    try {
      // Call through the bound LLM connection using callMeshTool
      // Response structure: { content: [{ type: "text", text: "..." }], finishReason, usage }
      const result = await callMeshTool<{
        content?: Array<{ type: string; text: string }>;
        text?: string;
        finishReason?: string;
        usage?: { promptTokens: number; completionTokens: number };
      }>(llmConnectionId, "LLM_DO_GENERATE", {
        modelId,
        callOptions,
      });

      // Extract text from content array
      if (result?.content && Array.isArray(result.content)) {
        const textPart = result.content.find((c) => c.type === "text");
        if (textPart?.text) {
          return textPart.text;
        }
      }

      // Fallback: check if text is directly on result
      if (result?.text) {
        return result.text;
      }

      console.error(
        "[MeshClient] LLM response structure unexpected:",
        JSON.stringify(result).slice(0, 200),
      );
      return "No response generated";
    } catch (error) {
      console.error("[MeshClient] LLM_DO_GENERATE failed:", error);
      throw error;
    }
  }

  /**
   * Generate with tool calling support.
   * The LLM can call tools and we execute them, returning results.
   */
  async generateWithTools(
    modelId: string,
    messages: Message[],
    tools: ToolDefinition[],
    executeToolFn: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    options: { maxTokens?: number; temperature?: number; maxIterations?: number } = {},
  ): Promise<string> {
    const llmConnectionId = getLLMConnectionId();
    if (!llmConnectionId) {
      throw new Error("LLM binding not configured");
    }

    const maxIterations = options.maxIterations ?? 5;
    let currentMessages = [...messages];

    for (let i = 0; i < maxIterations; i++) {
      console.error(`[MeshClient] Tool loop iteration ${i + 1}/${maxIterations}`);

      // Convert messages to LLM format
      const prompt = currentMessages.map((m) => {
        if (m.role === "system") {
          return { role: "system", content: m.content };
        }
        return {
          role: m.role,
          content: [{ type: "text", text: m.content }],
        };
      });

      // Convert tools to AI SDK format
      // See: https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
      const toolsForLLM = tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));

      const callOptions = {
        prompt,
        tools: toolsForLLM,
        toolChoice: { type: "auto" as const }, // AI SDK expects { type: "auto" }, not just "auto"
        ...(options.maxTokens && { maxOutputTokens: options.maxTokens }),
        ...(options.temperature && { temperature: options.temperature }),
      };

      console.error(
        `[MeshClient] Sending ${toolsForLLM.length} tools with toolChoice: { type: "auto" }`,
      );

      try {
        console.error(`[MeshClient] Calling LLM with ${toolsForLLM.length} tools available`);
        const result = await callMeshTool<{
          content?: Array<{
            type: string;
            text?: string;
            // AI SDK format for tool calls
            toolCallId?: string;
            toolName?: string;
            args?: Record<string, unknown>;
            // Some providers return `input` as JSON string instead of `args`
            input?: string | Record<string, unknown>;
          }>;
          text?: string;
          toolCalls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
          finishReason?: string;
        }>(llmConnectionId, "LLM_DO_GENERATE", { modelId, callOptions });

        console.error(`[MeshClient] LLM result:`, JSON.stringify(result).slice(0, 800));
        console.error(`[MeshClient] finishReason:`, result?.finishReason);

        // Extract tool calls from content array (AI SDK format)
        const toolCallsFromContent = result?.content?.filter((c) => c.type === "tool-call") || [];
        console.error(`[MeshClient] Tool calls in content:`, toolCallsFromContent.length);

        // Also check legacy toolCalls field
        const legacyToolCalls = result?.toolCalls || [];
        console.error(`[MeshClient] Legacy toolCalls:`, legacyToolCalls.length);

        // Combine both sources
        // Note: AI SDK returns `input` as a JSON string, not `args` as object
        const allToolCalls = [
          ...toolCallsFromContent.map((tc) => {
            // Handle both `args` (object) and `input` (JSON string) formats
            let parsedArgs: Record<string, unknown> = {};
            if (tc.args && typeof tc.args === "object") {
              parsedArgs = tc.args;
            } else if ((tc as any).input) {
              // AI SDK sometimes returns `input` as a JSON string
              const inputField = (tc as any).input;
              if (typeof inputField === "string") {
                try {
                  parsedArgs = JSON.parse(inputField);
                } catch (e) {
                  console.error(
                    `[MeshClient] Failed to parse tool input JSON:`,
                    inputField.slice(0, 100),
                  );
                }
              } else if (typeof inputField === "object") {
                parsedArgs = inputField;
              }
            }
            console.error(
              `[MeshClient] Parsed tool call: ${tc.toolName} with args:`,
              JSON.stringify(parsedArgs).slice(0, 200),
            );
            return {
              name: tc.toolName!,
              arguments: parsedArgs,
            };
          }),
          ...legacyToolCalls.map((tc) => ({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || "{}"),
          })),
        ];

        // Check for tool calls
        if (allToolCalls.length > 0) {
          console.error(
            `[MeshClient] LLM wants to call ${allToolCalls.length} tool(s):`,
            allToolCalls.map((t) => t.name),
          );

          // Extract any text response first
          let assistantText = "";
          if (result?.content) {
            const textPart = result.content.find((c) => c.type === "text");
            if (textPart?.text) assistantText = textPart.text;
          }

          // Add assistant message with tool calls
          if (assistantText) {
            currentMessages.push({ role: "assistant", content: assistantText });
          }

          // Execute each tool call
          for (const tc of allToolCalls) {
            const toolName = tc.name;
            const toolArgs = tc.arguments;
            const startTime = Date.now();

            console.error(`\n${"=".repeat(60)}`);
            console.error(`[TOOL CALL] ${toolName}`);
            console.error(`${"=".repeat(60)}`);
            console.error(`[TOOL CALL] Arguments:`);
            console.error(JSON.stringify(toolArgs, null, 2));
            console.error(`[TOOL CALL] Executing...`);

            try {
              const toolResult = await executeToolFn(toolName, toolArgs as Record<string, unknown>);
              const duration = Date.now() - startTime;
              const resultStr =
                typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);

              console.error(`[TOOL CALL] ✓ ${toolName} completed in ${duration}ms`);
              console.error(`[TOOL CALL] Result:`);
              console.error(resultStr.slice(0, 2000));
              console.error(`${"=".repeat(60)}\n`);

              // Add tool result as user message (simplified approach)
              currentMessages.push({
                role: "user",
                content: `[Tool Result for ${toolName}]:\n${resultStr.slice(0, 3000)}`,
              });
            } catch (error) {
              const duration = Date.now() - startTime;
              console.error(`[TOOL CALL] ✗ ${toolName} FAILED in ${duration}ms`);
              console.error(`[TOOL CALL] Error:`, error);
              console.error(`${"=".repeat(60)}\n`);
              currentMessages.push({
                role: "user",
                content: `[Tool Error for ${toolName}]: ${error instanceof Error ? error.message : "Unknown error"}`,
              });
            }
          }

          // Continue loop to get final response
          continue;
        }

        // No tool calls - return the text response
        if (result?.content && Array.isArray(result.content)) {
          const textPart = result.content.find((c) => c.type === "text");
          if (textPart?.text) return textPart.text;
        }
        if (result?.text) return result.text;

        return "No response generated";
      } catch (error) {
        console.error("[MeshClient] Tool generation failed:", error);
        throw error;
      }
    }

    return "Reached maximum tool iterations";
  }

  /**
   * Call perplexity_ask for quick answers via Perplexity
   */
  async perplexityAsk(messages: Message[]): Promise<string> {
    try {
      const result = (await this.callTool("perplexity_ask", {
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      })) as { content?: string; citations?: string[] };

      return result?.content || "No response";
    } catch (error) {
      console.error("[MeshClient] perplexity_ask failed:", error);
      throw error;
    }
  }
}

// Global mesh client instance
let meshClient: MeshClient | null = null;

export function getMeshClient(): MeshClient {
  if (!meshClient) {
    meshClient = new MeshClient(getMeshUrl());
  }
  return meshClient;
}

/**
 * Reset the mesh client (useful when context changes)
 */
export function resetMeshClient(): void {
  meshClient = null;
}

/**
 * Check if mesh is available (quick check without listing tools)
 * Returns unavailable if we don't have a token yet (STDIO mode before ON_MCP_CONFIGURATION)
 */
export async function checkMeshAvailability(): Promise<{
  available: boolean;
  hasLLM: boolean;
  tools: string[];
}> {
  // In STDIO mode, we need ON_MCP_CONFIGURATION to be called first
  // Don't try to call the mesh without a token
  const hasToken = !!(meshRequestContext?.authorization || config.mesh.apiKey);
  if (!hasToken) {
    // Silently return unavailable - this is expected before ON_MCP_CONFIGURATION
    return {
      available: false,
      hasLLM: false,
      tools: [],
    };
  }

  // Quick check - just verify we can connect, don't list all tools
  // Tools are loaded lazily by the Agent on first message
  try {
    const client = getMeshClient();
    await client.initialize(); // Just ensure we can connect

    // We assume LLM is available if mesh is available (verified when actually used)
    return {
      available: true,
      hasLLM: true, // Assume available, will be verified on use
      tools: [], // Don't list tools eagerly - Agent does this lazily
    };
  } catch {
    // Expected when mesh is not running
    return {
      available: false,
      hasLLM: false,
      tools: [],
    };
  }
}

/**
 * Check if we're running inside the mesh (have context)
 */
export function isRunningInMesh(): boolean {
  return meshRequestContext !== null;
}
