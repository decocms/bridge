#!/usr/bin/env node
/**
 * mesh-bridge - Unified Entry Point
 *
 * Auto-detects the appropriate mode based on environment:
 * - STDIO mode: When MESH_TOKEN is provided (running inside MCP Mesh)
 * - Standalone mode: When no MESH_TOKEN (running manually)
 *
 * Usage:
 *   bun run server/index.ts           # Auto-detect mode
 *   MESH_TOKEN=xxx bun run server/index.ts  # Force STDIO mode
 */

import { config, validateConfig } from "./config.ts";

const BRIDGE_VERSION = "0.1.0";

/**
 * Detect if we should run in STDIO mode (inside mesh) or standalone
 */
function detectMode(): "stdio" | "standalone" {
  // If MESH_TOKEN is provided, we're running inside mesh via STDIO
  if (process.env.MESH_TOKEN && process.env.MESH_URL) {
    return "stdio";
  }

  // If stdin is not a TTY, we're likely being spawned by mesh for tool fetch
  // (mesh uses pipes for STDIO communication)
  if (!process.stdin.isTTY) {
    return "stdio";
  }

  // Otherwise, run in standalone mode
  return "standalone";
}

async function main() {
  const mode = detectMode();

  if (mode === "stdio") {
    // Run STDIO mode - import and run the STDIO server
    console.error(`[mesh-bridge] Running in STDIO mode (mesh-hosted)`);
    await import("./stdio.ts");
  } else {
    // Run standalone mode - import and run the standalone server
    console.error(`[mesh-bridge] Running in standalone mode`);
    await import("./main.ts");
  }
}

main().catch((error) => {
  console.error("[mesh-bridge] Fatal error:", error);
  process.exit(1);
});
