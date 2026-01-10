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
import { cliDomain } from "./domains/cli/index.ts";

// Import the WebSocket server starter
import {
  startWebSocketServer,
  stopWebSocketServer,
  resetMeshStatus,
  handleIncomingEvents,
} from "./websocket.ts";

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
 * Tool definitions for EVENT_BUS binding.
 * Used for tool-based connection matching (finds gateway's self-connection).
 */
const EVENT_BUS_BINDING_TOOLS = [{ name: "EVENT_PUBLISH" }, { name: "EVENT_SUBSCRIBE" }];

/**
 * Creates a binding with tool-based matching.
 * Use for well-known bindings that aren't real MCP apps (like EVENT_BUS).
 */
const BindingWithTools = (bindingType: string) =>
  z.object({
    __type: z.literal(bindingType).default(bindingType),
    value: z.string().describe("Connection ID"),
  });

/**
 * State schema for stdio mode bindings.
 * Defines what bindings we need from the mesh UI.
 *
 * Bridge only needs EVENT_BUS for:
 * - Publishing user messages to Pilot
 * - Receiving agent responses from Pilot
 *
 * Pilot handles all LLM/Connection/Tool logic.
 */
const StdioStateSchema = z.object({
  EVENT_BUS: BindingWithTools("EVENT_BUS").describe("Event bus for pub/sub with Pilot agent"),
});

/**
 * Scopes we require - what tools we need from the bindings
 */
const requiredScopes = ["EVENT_BUS::*"];

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
  const processId = `${process.pid}`;
  console.error(`[mesh-bridge] Starting process ${processId}`);

  // Read mesh credentials from env vars (passed by mesh when spawning STDIO process)
  const meshToken = process.env.MESH_TOKEN;
  const meshUrl = process.env.MESH_URL;
  const meshStateJson = process.env.MESH_STATE;

  console.error(
    `[mesh-bridge] Env vars: MESH_TOKEN=${meshToken ? "set" : "not set"}, MESH_URL=${meshUrl || "not set"}, MESH_STATE=${meshStateJson ? `${meshStateJson.length} chars` : "not set"}`,
  );

  // Parse state from JSON env var
  let meshState: Record<string, unknown> = {};
  if (meshStateJson) {
    try {
      meshState = JSON.parse(meshStateJson);
      console.error(`[mesh-bridge] Parsed MESH_STATE keys: ${Object.keys(meshState).join(", ")}`);
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
    const eventBusBinding = meshState.EVENT_BUS as { value?: string } | undefined;
    if (eventBusBinding?.value) {
      console.error(`[mesh-bridge] ✅ EVENT_BUS binding: ${eventBusBinding.value}`);
    } else {
      console.error(`[mesh-bridge] ⚠️ EVENT_BUS binding not found in state`);
      console.error(`[mesh-bridge] State keys: ${Object.keys(meshState).join(", ")}`);
    }
  } else {
    console.error("[mesh-bridge] ⚠️ No MESH_TOKEN/MESH_URL - running without mesh access");
    console.error(`[mesh-bridge]   MESH_TOKEN: ${meshToken ? "set" : "not set"}`);
    console.error(`[mesh-bridge]   MESH_URL: ${meshUrl || "not set"}`);
  }

  // Register domains
  registerDomain(whatsappDomain);
  registerDomain(cliDomain);

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
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      logTool("MCP_CONFIGURATION", {});

      const rawStateSchema = zodToJsonSchema(StdioStateSchema, {
        $refStrategy: "none",
      });

      // Inject __binding for tool-based matching
      const stateSchema = rawStateSchema as Record<string, unknown>;
      const props = stateSchema.properties as Record<string, Record<string, unknown>> | undefined;
      if (props?.EVENT_BUS?.properties) {
        const ebProps = props.EVENT_BUS.properties as Record<string, Record<string, unknown>>;
        ebProps.__binding = {
          const: EVENT_BUS_BINDING_TOOLS,
        };
      }

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

  // =========================================================================
  // ON_EVENTS - Receive events from mesh event bus
  // =========================================================================

  server.registerTool(
    "ON_EVENTS",
    {
      title: "Receive Events",
      description:
        "Receive CloudEvents from the mesh event bus. Used for agent responses and progress updates.",
      inputSchema: z.object({
        events: z.array(
          z.object({
            id: z.string(),
            type: z.string(),
            source: z.string(),
            time: z.string().optional(),
            data: z.any(),
          }),
        ),
      }),
    },
    async (args) => {
      const { events } = args;
      // Log immediately with flush to ensure visibility
      const eventTypes = events.map((e: { type: string }) => e.type);
      console.error(
        `[mesh-bridge] ON_EVENTS RECEIVED: ${events.length} events, types: [${eventTypes.join(", ")}]`,
      );

      try {
        const results = await handleIncomingEvents(events);
        console.error(`[mesh-bridge] ON_EVENTS COMPLETE: ${JSON.stringify(results).slice(0, 200)}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
          structuredContent: { results },
        };
      } catch (error) {
        console.error(`[mesh-bridge] ON_EVENTS ERROR: ${error}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
          isError: true,
        };
      }
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
            inputSchema: z.object({}), // Domain tools need session context anyway
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
  console.error("  - ON_EVENTS");
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

  // Startup log - concise format
  const hasMeshAccess = !!(meshToken && meshUrl);
  const domainList = domains.map((d) => d.id).join(", ");
  if (wsServer) {
    console.error(`[mesh-bridge] Started v${BRIDGE_VERSION} (STDIO)`);
    console.error(`[mesh-bridge]   WebSocket: ws://localhost:${wsPort}`);
    console.error(`[mesh-bridge]   Domains: ${domainList}`);
    console.error(`[mesh-bridge]   Mesh: ${hasMeshAccess ? "✅ connected" : "❌ no credentials"}`);
  } else {
    console.error(`[mesh-bridge] Tool-fetch mode (WS on another instance)`);
  }
}

main().catch((error) => {
  console.error("[mesh-bridge] Fatal error:", error);
  process.exit(1);
});
