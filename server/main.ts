/**
 * mesh-bridge - Main Server Entry Point (Standalone Mode)
 *
 * A universal browser bridge that connects any website to your MCP Mesh.
 * Domains define site-specific behavior (WhatsApp, LinkedIn, X, etc.) — RPA for any website
 *
 * This is the standalone entry point - run manually with `bun run dev`.
 * For mesh-hosted mode, use `server/stdio.ts` instead.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     MCP Mesh (port 3000)                        │
 * │  OpenRouter · Perplexity · Custom MCPs · Tools                  │
 * └──────────────────────────────┬──────────────────────────────────┘
 *                                │
 * ┌──────────────────────────────┴──────────────────────────────────┐
 * │                   MESH BRIDGE (port 9999)                        │
 * │  Domains · Sessions · Protocol · Routing                        │
 * │  ┌─────────────┬─────────────┬─────────────┐                    │
 * │  │  WhatsApp   │  LinkedIn   │      X      │  ...any site       │
 * │  └─────────────┴─────────────┴─────────────┘                    │
 * └──────────────────────────────┬──────────────────────────────────┘
 *                                │
 *                    Browser Extension (any site)
 */

import { config, validateConfig } from "./config.ts";
import { registerDomain, getAllDomains } from "./core/domain.ts";
import { checkMeshAvailability } from "./core/mesh-client.ts";
import { startWebSocketServer } from "./websocket.ts";

// Import domains
import { whatsappDomain } from "./domains/whatsapp/index.ts";

// ============================================================================
// Initialize
// ============================================================================

validateConfig();

const BRIDGE_VERSION = "0.1.0";

// Register domains
registerDomain(whatsappDomain);

// Start WebSocket server
const server = startWebSocketServer(config.wsPort);

// Banner
const domains = getAllDomains();

if (server) {
  const domainList = domains.map((d) => d.id).join(", ");
  console.log(`[mesh-bridge] Started v${BRIDGE_VERSION} (Standalone)`);
  console.log(`[mesh-bridge]   WebSocket: ws://localhost:${server.port}`);
  console.log(`[mesh-bridge]   Mesh: ${config.mesh.url}`);
  console.log(`[mesh-bridge]   Domains: ${domainList}`);
  console.log(`[mesh-bridge]   Waiting for extension connection...`);
} else {
  console.log(`[mesh-bridge] Port ${config.wsPort} already in use (another instance running)`);
  // Don't exit with error - allow the process to complete for tool discovery scenarios
  // This happens when mesh spawns for "tool fetch" while another instance is running
}

// Check mesh availability in background (quick check, tools loaded lazily on first message)
setTimeout(async () => {
  try {
    const status = await checkMeshAvailability();
    if (status.available) {
      console.log(`[mesh-bridge] Mesh connected ✅ (tools loaded lazily on first message)`);
    }
  } catch {
    console.log("[mesh-bridge] Mesh not available (set MESH_API_KEY for standalone mode)");
  }
}, 1000);
