/**
 * Task History Tools
 *
 * Tools for viewing agent task history:
 * - LIST_TASKS - List recent tasks
 * - TASK_SUMMARY - Get task statistics
 * - GET_TASK - Get details of a specific task
 *
 * These are reusable across all domains.
 */

import type { LocalTool } from "../core/agent.ts";
import { getRecentTasks, getTaskSummary, getTask, type Task } from "../core/task-manager.ts";

// ============================================================================
// Task Tools
// ============================================================================

export const LIST_TASKS: LocalTool = {
  name: "LIST_TASKS",
  description:
    "List recent tasks with their status. Shows what the user has asked for and whether it completed, failed, or is in progress.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "How many tasks to return (default: 10, max: 50)",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "error"],
        description: "Filter by status (optional)",
      },
    },
  },
  execute: async (input) => {
    const { limit = 10 } = input as { limit?: number; status?: string };
    const tasks = await getRecentTasks(Math.min(limit, 50));

    return {
      tasks: tasks.map((t: Task) => ({
        id: t.id,
        status: t.status,
        message: t.userMessage.slice(0, 100),
        toolsUsed: t.toolsUsed.slice(0, 5),
        progress: t.progress.slice(-3),
        durationMs: t.durationMs,
        error: t.error,
        createdAt: t.createdAt,
      })),
      count: tasks.length,
    };
  },
};

export const TASK_SUMMARY: LocalTool = {
  name: "TASK_SUMMARY",
  description: "Get a summary of task history: total counts, recent tasks, success/error rates.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    return await getTaskSummary();
  },
};

export const GET_TASK: LocalTool = {
  name: "GET_TASK",
  description: "Get full details of a specific task by ID, including all progress updates.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to retrieve",
      },
    },
    required: ["taskId"],
  },
  execute: async (input) => {
    const { taskId } = input as { taskId: string };
    const task = await getTask(taskId);

    if (!task) {
      return { error: `Task not found: ${taskId}` };
    }

    return task;
  },
};

// ============================================================================
// Export All Task Tools
// ============================================================================

export const taskTools: LocalTool[] = [LIST_TASKS, TASK_SUMMARY, GET_TASK];
