/**
 * Mesh Integration Tools
 *
 * Tools for interacting with MCP Mesh connections:
 * - LIST_CONNECTIONS - List all MCP connections
 * - LIST_CONNECTION_TOOLS - List tools from a specific connection
 * - CALL_MESH_TOOL - Call a tool on a specific connection
 *
 * These are reusable across all domains.
 */

import type { LocalTool } from "../core/agent.ts";
import type { MeshClient } from "../core/mesh-client.ts";
import { callMeshTool, getConnectionBindingId } from "../core/mesh-client.ts";

// ============================================================================
// Factory Functions (require MeshClient instance)
// ============================================================================

/**
 * Create mesh integration tools with a MeshClient instance
 */
export function createMeshTools(meshClient: MeshClient): LocalTool[] {
  const LIST_CONNECTIONS: LocalTool = {
    name: "LIST_CONNECTIONS",
    description: "List all MCP connections in the mesh with their tool counts",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      console.error("[LIST_CONNECTIONS] Starting...");
      try {
        const connections = await meshClient.listConnections();
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
  };

  const LIST_CONNECTION_TOOLS: LocalTool = {
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
    execute: async (input) => {
      const { connectionId } = input as { connectionId: string };
      console.error(`[LIST_CONNECTION_TOOLS] Fetching tools for connection: ${connectionId}`);

      try {
        // Get connection details including tools
        const connections = await meshClient.listConnections();
        const connection = connections.find((c) => c.id === connectionId);

        if (!connection) {
          return {
            error: `Connection not found: ${connectionId}`,
            availableConnections: connections.map((c) => ({ id: c.id, name: c.title })),
            hint: "Use one of the available connection IDs above.",
          };
        }

        // Fetch the full connection with tools via COLLECTION_CONNECTIONS_GET
        const connBindingId = getConnectionBindingId();

        if (!connBindingId) {
          return {
            error: "CONNECTION binding not configured",
            hint: "Configure @deco/connection binding in Mesh UI.",
          };
        }

        const fullConnection = await callMeshTool<{
          item?: {
            id: string;
            title: string;
            tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
          };
        }>(connBindingId, "COLLECTION_CONNECTIONS_GET", { id: connectionId });

        const tools = fullConnection?.item?.tools || [];
        console.error(`[LIST_CONNECTION_TOOLS] Got ${tools.length} tools for ${connection.title}`);

        return {
          connectionId,
          connectionName: fullConnection?.item?.title || connection.title,
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
  };

  const CALL_MESH_TOOL: LocalTool = {
    name: "CALL_MESH_TOOL",
    description: "Call a tool from a specific MCP connection in the mesh",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Connection ID (get from LIST_CONNECTIONS)",
        },
        toolName: { type: "string", description: "Name of the tool to call" },
        args: { type: "object", description: "Arguments to pass to the tool" },
      },
      required: ["connectionId", "toolName"],
    },
    execute: async (input) => {
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
        const result = await meshClient.callConnectionTool(connectionId, toolName, args);
        return { connectionId, toolName, result };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Failed to call mesh tool",
          connectionId,
          toolName,
        };
      }
    },
  };

  return [LIST_CONNECTIONS, LIST_CONNECTION_TOOLS, CALL_MESH_TOOL];
}
