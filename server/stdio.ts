#!/usr/bin/env node
/**
 * mesh-bridge - STDIO Entry Point
 *
 * This is the entry point when mesh-bridge runs as a mesh-hosted MCP via STDIO.
 * The mesh calls this process and communicates via JSON-RPC over stdin/stdout.
 *
 * Flow:
 * 1. Mesh starts this process
 * 2. Mesh sends `initialize` request
 * 3. Mesh calls `MCP_CONFIGURATION` to get our state schema (bindings we need)
 * 4. User configures bindings in Mesh UI
 * 5. Mesh calls `ON_MCP_CONFIGURATION` with configured state + meshToken + meshUrl
 * 6. We start WebSocket server for extensions, use meshToken for mesh calls
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { setMeshRequestContext, resetMeshClient } from "./core/mesh-client.ts";
import { config, loadPersistedConfig, savePersistedConfig, getPersistedConfig } from "./config.ts";
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
 * Uses @deco/openrouter as the binding type - this matches the OpenRouter app
 * registered in the mesh registry, which implements the LANGUAGE_MODEL_BINDING.
 */
const StdioStateSchema = z.object({
  LLM: BindingOf("@deco/openrouter").describe("LLM binding for AI responses (OpenRouter)"),
});

/**
 * Scopes we require - what tools we need from the bindings
 * LLM_DO_GENERATE is the main tool for generating responses
 */
const requiredScopes = ["LLM::LLM_DO_GENERATE", "LLM::COLLECTION_LLM_LIST"];

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
  // Load persisted configuration (URL and bindings only, not the expired token)
  const persisted = loadPersistedConfig();
  if (persisted.meshUrl && persisted.state) {
    console.error("[mesh-bridge] Found persisted binding config (waiting for fresh token from mesh)...");
    // Don't restore the token - it's expired. Just remember the bindings.
    // The mesh will call ON_MCP_CONFIGURATION with a fresh token.
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

  // Binding schema for ON_MCP_CONFIGURATION input
  const BindingInputSchema = z
    .object({
      __type: z.string(),
      value: z.string(),
    })
    .optional();

  // ON_MCP_CONFIGURATION - Called when user saves bindings in Mesh UI
  server.registerTool(
    "ON_MCP_CONFIGURATION",
    {
      title: "On MCP Configuration",
      description:
        "Called by Mesh when the user saves binding configuration. Applies the configured state and mesh credentials.",
      inputSchema: {
        state: z
          .object({
            LLM: BindingInputSchema,
          })
          .passthrough()
          .describe("The configured state from the bindings UI"),
        scopes: z.array(z.string()).describe("List of authorized scopes"),
        meshToken: z
          .string()
          .optional()
          .describe("JWT token for authenticating with Mesh API"),
        meshUrl: z
          .string()
          .optional()
          .describe("Base URL of the Mesh instance"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      logTool("ON_MCP_CONFIGURATION", { state: args.state, scopes: args.scopes });

      console.error(`[ON_MCP_CONFIGURATION] Full args:`, JSON.stringify(args, null, 2));
      console.error(`  - meshUrl: ${args.meshUrl}`);
      console.error(`  - meshToken: ${args.meshToken ? "✅ provided" : "❌ missing"}`);
      console.error(`  - state: ${JSON.stringify(args.state)}`);

      const state = (args.state || {}) as { LLM?: { __type?: string; value?: string } };
      const llmConnectionId = state.LLM?.value;
      
      console.error(`  - LLM binding: ${llmConnectionId || "NOT CONFIGURED"}`);
      console.error(`  - LLM type: ${state.LLM?.__type || "unknown"}`);
      

      if (args.meshToken && args.meshUrl) {
        setMeshRequestContext({
          authorization: args.meshToken as string,
          state: state as Record<string, unknown>,
          meshUrl: args.meshUrl as string,
        });

        // Reset mesh client and status cache to pick up new token
        resetMeshClient();
        resetMeshStatus();

        // Persist configuration for future restarts (NOT the token - it expires)
        savePersistedConfig({
          meshUrl: args.meshUrl as string,
          llmConnectionId,
          state: state as Record<string, unknown>,
        });

        console.error(`[mesh-bridge] ✅ Mesh configured: ${args.meshUrl}`);
        if (llmConnectionId) {
          console.error(`[mesh-bridge] ✅ LLM binding: ${llmConnectionId}`);
        }
      } else {
        console.error("[mesh-bridge] ⚠️ Missing meshToken or meshUrl - mesh calls will fail");
      }

      const result = { success: true, configured: !!(args.meshToken && args.meshUrl) };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

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
  console.error("  - ON_MCP_CONFIGURATION");
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
  if (wsServer) {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║               MESH BRIDGE v${BRIDGE_VERSION} (STDIO Mode)                 ║
╠══════════════════════════════════════════════════════════════╣
║  Transport: STDIO (mesh-hosted)                              ║
║  WebSocket: ws://localhost:${wsPort}                            ║
║  Domains:   ${domains.map((d) => d.id).join(", ").padEnd(42)}║
║                                                              ║
║  Waiting for mesh configuration...                           ║
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
