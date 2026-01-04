/**
 * Configuration for mesh-bridge
 *
 * Mesh credentials are now passed via environment variables when spawning:
 * - MESH_TOKEN: JWT token for mesh API calls
 * - MESH_URL: Base URL of the mesh instance
 * - MESH_STATE: JSON-encoded state with binding values
 * - MESH_CONNECTION_ID: Our connection ID (for event subscriptions)
 *
 * Note: Bridge doesn't do AI processing - that's handled by Pilot.
 * Bridge just routes messages between browser extensions and the event bus.
 */

export const config = {
  // WebSocket server port for extension connection
  wsPort: parseInt(process.env.WS_PORT || "9999", 10),

  // MCP Mesh connection
  mesh: {
    url: process.env.MESH_URL || "http://localhost:3000",
  },

  // Terminal safety (for direct commands, not AI)
  terminal: {
    allowedPaths: (process.env.ALLOWED_PATHS || "").split(",").filter(Boolean),
    blockedCommands: (process.env.BLOCKED_COMMANDS || "rm -rf,sudo,chmod 777")
      .split(",")
      .filter(Boolean),
    timeout: 30000, // 30 seconds
  },

  // AI formatting
  aiPrefix: process.env.AI_PREFIX || "🤖 ",

  // Active domain (can be changed at runtime)
  activeDomain: null as string | null,
};

export function validateConfig(): void {
  console.log(`[mesh-bridge] Mesh URL: ${config.mesh.url}`);
  console.log(`[mesh-bridge] Connection ID: ${process.env.MESH_CONNECTION_ID || "(not set)"}`);

  if (config.terminal.allowedPaths.length === 0) {
    console.log("[mesh-bridge] Note: ALLOWED_PATHS not set. Terminal commands will be disabled.");
  }
}
