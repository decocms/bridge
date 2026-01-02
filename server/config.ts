/**
 * Configuration for mesh-bridge
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// Config file path - in the project root
const CONFIG_FILE = join(dirname(import.meta.dir), ".mesh-bridge-config.json");

/**
 * Persisted mesh configuration
 * NOTE: We do NOT persist meshToken because JWT tokens expire (typically 5 min).
 * The mesh sends a fresh token via ON_MCP_CONFIGURATION on each connection.
 */
interface PersistedConfig {
  meshUrl?: string;
  llmConnectionId?: string;
  state?: Record<string, unknown>;
  savedAt?: string;
}

let persistedConfig: PersistedConfig = {};

/**
 * Load persisted configuration from file
 */
export function loadPersistedConfig(): PersistedConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = readFileSync(CONFIG_FILE, "utf-8");
      persistedConfig = JSON.parse(data);
      console.error(`[config] Loaded persisted config from ${CONFIG_FILE}`);
      console.error(`[config]   - meshUrl: ${persistedConfig.meshUrl}`);
      console.error(`[config]   - llmConnectionId: ${persistedConfig.llmConnectionId}`);
      console.error(`[config]   - savedAt: ${persistedConfig.savedAt}`);
      return persistedConfig;
    }
  } catch (err) {
    console.error(`[config] Failed to load persisted config:`, err);
  }
  return {};
}

/**
 * Save configuration to file
 */
export function savePersistedConfig(cfg: PersistedConfig): void {
  try {
    persistedConfig = { ...cfg, savedAt: new Date().toISOString() };
    writeFileSync(CONFIG_FILE, JSON.stringify(persistedConfig, null, 2));
    console.error(`[config] Saved config to ${CONFIG_FILE}`);
  } catch (err) {
    console.error(`[config] Failed to save config:`, err);
  }
}

/**
 * Get the current persisted config
 */
export function getPersistedConfig(): PersistedConfig {
  return persistedConfig;
}

export const config = {
  // WebSocket server port for extension connection
  wsPort: parseInt(process.env.WS_PORT || "9999", 10),

  // MCP Mesh connection
  mesh: {
    url: process.env.MESH_URL || "http://localhost:3000",
    apiKey: process.env.MESH_API_KEY || null,
    defaultModel: process.env.DEFAULT_MODEL || "anthropic/claude-sonnet-4",
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
  console.log(`[mesh-bridge] Default model: ${config.mesh.defaultModel}`);

  if (config.terminal.allowedPaths.length === 0) {
    console.log(
      "[mesh-bridge] Note: ALLOWED_PATHS not set. Terminal commands will be disabled.",
    );
  }
}
