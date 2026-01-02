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
 * Get the LLM binding connection ID from state
 */
export function getLLMConnectionId(): string | undefined {
  if (!meshRequestContext) {
    console.error("[getLLMConnectionId] meshRequestContext is null - ON_MCP_CONFIGURATION not called yet");
    return undefined;
  }
  if (!meshRequestContext.state) {
    console.error("[getLLMConnectionId] meshRequestContext.state is undefined");
    return undefined;
  }
  const llmBinding = meshRequestContext.state.LLM as BindingValue | undefined;
  if (!llmBinding) {
    console.error("[getLLMConnectionId] LLM binding not in state. Available keys:", Object.keys(meshRequestContext.state));
    return undefined;
  }
  console.error("[getLLMConnectionId] Found LLM binding:", llmBinding.value);
  return llmBinding.value;
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
    throw new Error(
      "Mesh not configured. Configure bindings in Mesh UI first.",
    );
  }

  const endpoint = `${meshUrl}/mcp/${connectionId}`;
  console.error(`[callMeshTool] Calling ${endpoint} with tool: ${toolName}`);

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
      console.error(`[callMeshTool] ⚠️ TOKEN EXPIRED - Mesh should send ON_MCP_CONFIGURATION with fresh token`);
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

    const response = await fetch(this.getMcpUrl(), {
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
      throw new Error(`Mesh call failed: ${response.status} ${error}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(`Tool error: ${result.error.message}`);
    }

    // Extract content from result
    const content = result.result;

    if (content?.structuredContent) {
      return content.structuredContent;
    }

    if (content?.content?.[0]?.text) {
      try {
        return JSON.parse(content.content[0].text);
      } catch {
        return content.content[0].text;
      }
    }

    return content;
  }

  /**
   * List available tools on the mesh
   */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    await this.initialize();

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
      throw new Error(
        "LLM binding not configured. Configure the LLM binding in Mesh UI first.",
      );
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
 * Check if mesh is available and has required tools
 * Returns unavailable if we don't have a token yet (STDIO mode before ON_MCP_CONFIGURATION)
 */
export async function checkMeshAvailability(): Promise<{
  available: boolean;
  hasLLM: boolean;
  hasPerplexity: boolean;
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
      hasPerplexity: false,
      tools: [],
    };
  }

  try {
    const client = getMeshClient();
    const tools = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    return {
      available: true,
      hasLLM: toolNames.includes("LLM_DO_GENERATE"),
      hasPerplexity: toolNames.includes("perplexity_ask"),
      tools: toolNames,
    };
  } catch {
    // Expected when mesh is not running
    return {
      available: false,
      hasLLM: false,
      hasPerplexity: false,
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

