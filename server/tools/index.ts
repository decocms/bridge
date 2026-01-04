/**
 * Tools Index
 *
 * Exports all shared tools that can be used across domains.
 * Tools are organized into categories:
 * - System: File operations, shell, clipboard, notifications
 * - Speech: Text-to-speech
 * - Mesh: MCP Mesh integration
 * - Tasks: Task history and tracking
 */

// System tools
export {
  systemTools,
  LIST_FILES,
  READ_FILE,
  RUN_SHELL,
  LIST_APPS,
  GET_CLIPBOARD,
  SET_CLIPBOARD,
  SEND_NOTIFICATION,
} from "./system.ts";

// Speech tools
export {
  speechTools,
  SAY_TEXT,
  STOP_SPEAKING,
  speakText,
  stopSpeaking,
  detectLanguage,
  getVoiceForLanguage,
} from "./speech.ts";

// Mesh tools (factory function)
export { createMeshTools } from "./mesh.ts";

// Task tools
export { taskTools, LIST_TASKS, TASK_SUMMARY, GET_TASK } from "./tasks.ts";

// Re-export LocalTool type for convenience
export type { LocalTool } from "../core/agent.ts";

/**
 * Create all shared tools for a domain
 * Pass the MeshClient to get mesh integration tools
 */
import type { MeshClient } from "../core/mesh-client.ts";
import type { LocalTool } from "../core/agent.ts";
import { systemTools } from "./system.ts";
import { speechTools } from "./speech.ts";
import { createMeshTools } from "./mesh.ts";
import { taskTools } from "./tasks.ts";

export function createAllSharedTools(meshClient: MeshClient): LocalTool[] {
  return [...systemTools, ...speechTools, ...createMeshTools(meshClient), ...taskTools];
}
