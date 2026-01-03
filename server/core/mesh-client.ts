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
  if (!meshRequestContext?.state) return undefined;
  const binding = meshRequestContext.state[bindingName] as BindingValue | undefined;
  return binding?.value;
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
// Connection name cache for better logging
const connectionNameCache = new Map<string, string>();

export function cacheConnectionName(connectionId: string, name: string): void {
  connectionNameCache.set(connectionId, name);
}

function formatArgsForLog(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "{}";
  if (keys.length > 4) return `{${keys.slice(0, 3).join(", ")}... +${keys.length - 3}}`;

  const parts = keys.map((k) => {
    const v = args[k];
    if (typeof v === "string") {
      return `${k}:"${v.slice(0, 20)}${v.length > 20 ? "..." : ""}"`;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      return `${k}:${v}`;
    }
    if (Array.isArray(v)) {
      return `${k}:[${v.length}]`;
    }
    return `${k}:{...}`;
  });
  return `{${parts.join(", ")}}`;
}

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

  // Get connection name for logging
  const connName = connectionNameCache.get(connectionId) || connectionId.slice(0, 12);
  const argsStr = formatArgsForLog(args);
  const startTime = Date.now();

  console.error(`[Mesh] → ${connName}/${toolName} ${argsStr}`);

  const endpoint = `${meshUrl}/mcp/${connectionId}`;

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
    console.error(`[Mesh] ✗ ${toolName}: ${response.status} - ${text.slice(0, 100)}`);

    if (response.status === 401) {
      throw new Error(`Token expired (401). Restart mesh connection to get fresh credentials.`);
    }

    throw new Error(`Mesh API error (${response.status}): ${text}`);
  }

  // Handle both JSON and SSE responses
  const contentType = response.headers.get("Content-Type") || "";

  let json: {
    result?: {
      structuredContent?: T;
      content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    };
    error?: { message: string };
  };

  if (contentType.includes("text/event-stream")) {
    // Parse SSE response - extract JSON from data lines
    const text = await response.text();
    const lines = text.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    const lastData = dataLines[dataLines.length - 1];
    if (!lastData) {
      throw new Error("Empty SSE response from Mesh API");
    }
    try {
      json = JSON.parse(lastData.slice(6)); // Remove "data: " prefix
    } catch (parseError) {
      console.error(`[Mesh] ✗ Parse SSE failed: ${lastData.slice(6).slice(0, 100)}`);
      throw parseError;
    }
  } else {
    const text = await response.text();
    try {
      json = JSON.parse(text);
    } catch (parseError) {
      console.error(`[Mesh] ✗ Parse JSON failed: ${text.slice(0, 100)}`);
      throw parseError;
    }
  }

  if (json.error) {
    throw new Error(`Mesh tool error: ${json.error.message}`);
  }

  const duration = Date.now() - startTime;

  // Helper to log success and return
  const logSuccess = (result: T, type: string): T => {
    console.error(`[Mesh] ✓ ${connName}/${toolName} (${duration}ms) → ${type}`);
    return result;
  };

  // Return structured content if available
  if (json.result?.structuredContent) {
    return logSuccess(json.result.structuredContent as T, "structured");
  }

  // Process content array
  const content = json.result?.content;
  if (!content || content.length === 0) {
    console.error(`[Mesh] ✓ ${connName}/${toolName} (${duration}ms) → empty`);
    return null as T;
  }

  if (content && content.length > 0) {
    // Look for image content first (base64 data) - MCP standard format
    const imageItem = content.find((c) => c.type === "image" || c.data);
    if (imageItem?.data && imageItem?.mimeType) {
      const dataUrl = `data:${imageItem.mimeType};base64,${imageItem.data}`;
      return logSuccess({ image: dataUrl, mimeType: imageItem.mimeType } as T, "image");
    }

    // Look for text content
    const textItem = content.find((c) => c.type === "text" || c.text);
    if (textItem?.text) {
      if (textItem.text.startsWith("MCP error")) {
        console.error(`[Mesh] ✗ ${connName}/${toolName} (${duration}ms) → MCP error`);
        throw new Error(textItem.text);
      }
      try {
        const parsed = JSON.parse(textItem.text);
        // Check if parsed result contains an image (from OpenRouter)
        if (parsed.image && typeof parsed.image === "string" && parsed.image.startsWith("data:")) {
          return logSuccess(parsed as T, "image-json");
        }
        // Show brief result type
        const resultType = Array.isArray(parsed)
          ? `array[${parsed.length}]`
          : typeof parsed === "object"
            ? Object.keys(parsed).slice(0, 3).join(",")
            : typeof parsed;
        return logSuccess(parsed as T, resultType);
      } catch {
        // Check if text itself is a data URL
        if (textItem.text.startsWith("data:image/")) {
          return logSuccess({ image: textItem.text } as T, "image-data");
        }
        // If not JSON, return wrapped
        return logSuccess({ text: textItem.text } as T, `text(${textItem.text.length})`);
      }
    }
  }

  console.error(`[Mesh] ✓ ${connName}/${toolName} (${duration}ms) → null`);
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
   * List all connections in the mesh with their tools
   */
  async listConnections(): Promise<
    Array<{
      id: string;
      title: string;
      toolCount: number;
      tools: Array<{ name: string; description?: string }>;
    }>
  > {
    const connectionBindingId = getConnectionBindingId();
    if (!connectionBindingId) return [];

    try {
      const result = await callMeshTool<{
        items?: Array<{
          id: string;
          title: string;
          tools?: Array<{ name: string; description?: string }>;
        }>;
      }>(connectionBindingId, "COLLECTION_CONNECTIONS_LIST", {});

      return (result?.items || []).map((conn) => ({
        id: conn.id,
        title: conn.title,
        toolCount: conn.tools?.length || 0,
        tools: conn.tools || [],
      }));
    } catch {
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
