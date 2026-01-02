#!/usr/bin/env node
/**
 * mesh-bridge - STDIO Entry Point
 *
 * This is the entry point when mesh-bridge runs as a mesh-hosted MCP via STDIO.
 * The mesh calls this process and communicates via JSON-RPC over stdin/stdout.
 *
 * Mesh credentials are passed via environment variables:
 * - MESH_TOKEN: JWT token for authenticating with Mesh API
 * - MESH_URL: Base URL of the Mesh instance
 * - MESH_STATE: JSON-encoded state with binding values
 *
 * Flow:
 * 1. Mesh starts this process with MESH_TOKEN/MESH_URL/MESH_STATE env vars
 * 2. Mesh sends `initialize` request
 * 3. Mesh calls `MCP_CONFIGURATION` to get our state schema (bindings we need)
 * 4. We're ready to make mesh calls using MESH_TOKEN
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { setMeshRequestContext } from "./core/mesh-client.ts";
import { config } from "./config.ts";
import { registerDomain, getAllDomains } from "./core/domain.ts";

// Import the WebSocket server starter
import { startWebSocketServer, resetMeshStatus } from "./websocket.ts";

// Import domains
import { whatsappDomain } from "./domains/whatsapp/index.ts";

const BRIDGE_VERSION = "0.1.0";

// ============================================================================
// Configuration State (Bindings)
// ============================================================================

/**
 * Creates a binding schema compatible with Mesh UI.
 * This produces the same format as @decocms/runtime's BindingOf.
 */
const BindingOf = (bindingType: string) =>
  z.object({
    __type: z.literal(bindingType).default(bindingType),
    value: z.string().describe("Connection ID"),
  });

/**
 * State schema for stdio mode bindings.
 * Defines what bindings we need from the mesh UI.
 *
 * Based on how mcp-studio does it:
 * - LLM: For AI responses (@deco/openrouter)
 * - CONNECTION: For listing/calling tools from other MCPs (@deco/connection)
 * - DATABASE: For SQL queries (@deco/postgres) - optional
 * - EVENT_BUS: For pub/sub events (@deco/event-bus) - optional
 */
const StdioStateSchema = z.object({
  LLM: BindingOf("@deco/openrouter").describe("LLM for AI responses"),
  CONNECTION: BindingOf("@deco/connection").describe("Access to other MCP connections"),
  DATABASE: BindingOf("@deco/postgres").optional().describe("Database for SQL queries (optional)"),
  EVENT_BUS: BindingOf("@deco/event-bus").optional().describe("Event bus for pub/sub (optional)"),
});

/**
 * Scopes we require - what tools we need from the bindings
 */
const requiredScopes = [
  "LLM::LLM_DO_GENERATE",
  "LLM::COLLECTION_LLM_LIST",
  "CONNECTION::COLLECTION_CONNECTIONS_LIST",
  "CONNECTION::COLLECTION_CONNECTIONS_GET",
  "DATABASE::DATABASES_RUN_SQL",
  "EVENT_BUS::*",
];

// ============================================================================
// Tool Logging Helper
// ============================================================================

function logTool(name: string, args: Record<string, unknown>) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 50)}`)
    .join(" ");
  console.error(`[mesh-bridge] ${name}${argStr ? ` ${argStr}` : ""}`);
}

async function main() {
  // Read mesh credentials from env vars (passed by mesh when spawning STDIO process)
  const meshToken = process.env.MESH_TOKEN;
  const meshUrl = process.env.MESH_URL;
  const meshStateJson = process.env.MESH_STATE;

  // Parse state from JSON env var
  let meshState: Record<string, unknown> = {};
  if (meshStateJson) {
    try {
      meshState = JSON.parse(meshStateJson);
    } catch (e) {
      console.error("[mesh-bridge] Failed to parse MESH_STATE:", e);
    }
  }

  // Set mesh context from env vars - ready to make mesh calls immediately
  if (meshToken && meshUrl) {
    setMeshRequestContext({
      authorization: meshToken,
      state: meshState,
      meshUrl: meshUrl,
    });
    console.error(`[mesh-bridge] ✅ Mesh context from env vars: ${meshUrl}`);
    const llmBinding = meshState.LLM as { value?: string } | undefined;
    if (llmBinding?.value) {
      console.error(`[mesh-bridge] ✅ LLM binding: ${llmBinding.value}`);
    }
  } else {
    console.error("[mesh-bridge] ⚠️ No MESH_TOKEN/MESH_URL - running without mesh access");
  }

  // Register domains
  registerDomain(whatsappDomain);

  // Create MCP server
  const server = new McpServer({
    name: "mesh-bridge",
    version: BRIDGE_VERSION,
  });

  // =========================================================================
  // MCP Configuration Tools (for Mesh bindings UI)
  // =========================================================================

  // MCP_CONFIGURATION - Returns the state schema for the bindings UI
  server.registerTool(
    "MCP_CONFIGURATION",
    {
      title: "MCP Configuration",
      description:
        "Returns the configuration schema for this MCP server. Used by Mesh to show the bindings UI.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      logTool("MCP_CONFIGURATION", {});

      const stateSchema = zodToJsonSchema(StdioStateSchema, {
        $refStrategy: "none",
      });

      const result = {
        stateSchema,
        scopes: requiredScopes,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  // Note: ON_MCP_CONFIGURATION is no longer needed - mesh passes credentials via env vars
  // The MCP_CONFIGURATION tool above is still needed for the bindings UI

  // Register domain-specific tools
  // Note: These tools require a WebSocket session context to work properly.
  // When called via STDIO without a session, they return a "no session" error.
  const domains = getAllDomains();
  for (const domain of domains) {
    if (domain.tools) {
      for (const tool of domain.tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema || {},
          },
          async (args) => {
            logTool(tool.name, args as Record<string, unknown>);
            // Domain tools require a session context (from WebSocket connection)
            // When called directly via STDIO, return an informative error
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: "This tool requires an active browser session",
                    hint: "Connect via WhatsApp Web extension first",
                  }),
                },
              ],
              isError: true,
            };
          },
        );
      }
    }
  }

  // Log registered tools
  console.error("[mesh-bridge] Registered tools:");
  console.error("  - MCP_CONFIGURATION");
  domains.forEach((domain) => {
    domain.tools?.forEach((tool) => {
      console.error(`  - ${tool.name}`);
    });
  });

  // Connect to STDIO transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start WebSocket server for browser extensions
  // If port is already in use (another instance running), this returns null
  const wsPort = config.wsPort;
  const wsServer = startWebSocketServer(wsPort);

  // Log to stderr (stdout is for MCP protocol)
  const hasMeshAccess = !!(meshToken && meshUrl);
  if (wsServer) {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║               MESH BRIDGE v${BRIDGE_VERSION} (STDIO Mode)                 ║
╠══════════════════════════════════════════════════════════════╣
║  Transport: STDIO (mesh-hosted)                              ║
║  WebSocket: ws://localhost:${wsPort}                            ║
║  Domains:   ${domains
      .map((d) => d.id)
      .join(", ")
      .padEnd(42)}║
║  Mesh:      ${hasMeshAccess ? "✅ Connected".padEnd(42) : "❌ No credentials".padEnd(42)}║
╚══════════════════════════════════════════════════════════════╝
`);
  } else {
    console.error(`[mesh-bridge] Running in tool-fetch mode (WS server on another instance)`);
  }
}

main().catch((error) => {
  console.error("[mesh-bridge] Fatal error:", error);
  process.exit(1);
});
