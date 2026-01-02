/**
 * Configuration for mesh-bridge
 *
 * Mesh credentials are now passed via environment variables when spawning:
 * - MESH_TOKEN: JWT token for mesh API calls
 * - MESH_URL: Base URL of the mesh instance
 * - MESH_STATE: JSON-encoded state with binding values
 */

export const config = {
  // WebSocket server port for extension connection
  wsPort: parseInt(process.env.WS_PORT || "9999", 10),

  // MCP Mesh connection
  mesh: {
    url: process.env.MESH_URL || "http://localhost:3000",
    apiKey: process.env.MESH_API_KEY || null,
    defaultModel: process.env.DEFAULT_MODEL || "google/gemini-2.5-flash",
    /** Fast model for routing - cheap and quick */
    fastModel: process.env.FAST_MODEL || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash",
    /** Smart model for complex execution - optional, defaults to fastModel */
    smartModel: process.env.SMART_MODEL || undefined,
  },

  // Terminal safety
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
  console.log(`[mesh-bridge] Fast model (router): ${config.mesh.fastModel}`);
  console.log(
    `[mesh-bridge] Smart model (executor): ${config.mesh.smartModel || "(same as fast)"}`,
  );
  console.log(`[mesh-bridge] Default model: ${config.mesh.defaultModel}`);

  if (config.terminal.allowedPaths.length === 0) {
    console.log("[mesh-bridge] Note: ALLOWED_PATHS not set. Terminal commands will be disabled.");
  }
}
