import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

// Task data directory
const DATA_DIR = join(import.meta.dir, "../../data");
const TASKS_DIR = join(DATA_DIR, "tasks");
const CURRENT_TASKS_FILE = join(TASKS_DIR, "current.json");

export interface TaskProgress {
  timestamp: string;
  message: string;
}

export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "in_progress" | "completed" | "error";
  userMessage: string;
  response?: string;
  progress: TaskProgress[];
  error?: string;
  toolsUsed: string[];
  durationMs?: number;
}

interface TaskStore {
  tasks: Task[];
  lastUpdated: string;
}

// Ensure data directories exist
async function ensureDataDirs(): Promise<void> {
  try {
    await mkdir(TASKS_DIR, { recursive: true });
  } catch {
    // Directory might already exist
  }
}

// Load current tasks
async function loadTasks(): Promise<TaskStore> {
  try {
    const data = await readFile(CURRENT_TASKS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { tasks: [], lastUpdated: new Date().toISOString() };
  }
}

// Save tasks
async function saveTasks(store: TaskStore): Promise<void> {
  await ensureDataDirs();
  store.lastUpdated = new Date().toISOString();
  await writeFile(CURRENT_TASKS_FILE, JSON.stringify(store, null, 2));
}

// Generate task ID
function generateTaskId(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0].replace(/:/g, "");
  const rand = Math.random().toString(36).substring(2, 6);
  return `task_${date}_${time}_${rand}`;
}

/**
 * Create a new task
 */
export async function createTask(userMessage: string): Promise<Task> {
  const store = await loadTasks();

  const task: Task = {
    id: generateTaskId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "pending",
    userMessage: userMessage.slice(0, 500), // Truncate long messages
    progress: [],
    toolsUsed: [],
  };

  // Keep only last 10 tasks
  store.tasks = [task, ...store.tasks.slice(0, 9)];
  await saveTasks(store);

  return task;
}

/**
 * Update task status
 */
export async function updateTaskStatus(
  taskId: string,
  status: Task["status"],
  response?: string,
  error?: string,
): Promise<void> {
  const store = await loadTasks();
  const task = store.tasks.find((t) => t.id === taskId);

  if (task) {
    task.status = status;
    task.updatedAt = new Date().toISOString();

    if (response) task.response = response.slice(0, 2000); // Truncate
    if (error) task.error = error;

    // Calculate duration
    if (status === "completed" || status === "error") {
      const start = new Date(task.createdAt).getTime();
      task.durationMs = Date.now() - start;
    }

    await saveTasks(store);
  }
}

/**
 * Add progress to a task
 */
export async function addTaskProgress(taskId: string, message: string): Promise<void> {
  const store = await loadTasks();
  const task = store.tasks.find((t) => t.id === taskId);

  if (task) {
    task.progress.push({
      timestamp: new Date().toISOString(),
      message,
    });
    task.updatedAt = new Date().toISOString();
    task.status = "in_progress";

    // Keep only last 20 progress entries per task
    if (task.progress.length > 20) {
      task.progress = task.progress.slice(-20);
    }

    await saveTasks(store);
  }
}

/**
 * Add a tool to the task's toolsUsed list
 */
export async function addToolUsed(taskId: string, toolName: string): Promise<void> {
  const store = await loadTasks();
  const task = store.tasks.find((t) => t.id === taskId);

  if (task && !task.toolsUsed.includes(toolName)) {
    task.toolsUsed.push(toolName);
    await saveTasks(store);
  }
}

/**
 * Get recent tasks
 */
export async function getRecentTasks(limit = 10): Promise<Task[]> {
  const store = await loadTasks();
  return store.tasks.slice(0, limit);
}

/**
 * Get a specific task by ID
 */
export async function getTask(taskId: string): Promise<Task | null> {
  const store = await loadTasks();
  return store.tasks.find((t) => t.id === taskId) || null;
}

/**
 * Get tasks by status
 */
export async function getTasksByStatus(status: Task["status"]): Promise<Task[]> {
  const store = await loadTasks();
  return store.tasks.filter((t) => t.status === status);
}

/**
 * Cleanup stale tasks:
 * - Mark in_progress tasks older than 5 minutes as "error" (stale)
 * - Mark pending tasks older than 1 minute as "error" (abandoned)
 * - Keep only the last 10 tasks
 */
export async function cleanupTasks(): Promise<{ cleaned: number; removed: number }> {
  const store = await loadTasks();
  const now = Date.now();
  let cleaned = 0;

  for (const task of store.tasks) {
    const age = now - new Date(task.updatedAt).getTime();

    // Mark stale in_progress tasks (older than 5 minutes)
    if (task.status === "in_progress" && age > 5 * 60 * 1000) {
      task.status = "error";
      task.error = "Task timed out (stale)";
      task.updatedAt = new Date().toISOString();
      cleaned++;
    }

    // Mark abandoned pending tasks (older than 1 minute)
    if (task.status === "pending" && age > 60 * 1000) {
      task.status = "error";
      task.error = "Task abandoned (never started)";
      task.updatedAt = new Date().toISOString();
      cleaned++;
    }
  }

  // Keep only last 10 tasks
  const removed = Math.max(0, store.tasks.length - 10);
  store.tasks = store.tasks.slice(0, 10);

  if (cleaned > 0 || removed > 0) {
    await saveTasks(store);
  }

  return { cleaned, removed };
}

/**
 * Get task summary for display (also cleans up stale tasks)
 */
export async function getTaskSummary(): Promise<{
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  error: number;
  recentTasks: Array<{
    id: string;
    status: string;
    message: string;
    age: string;
  }>;
}> {
  // Cleanup stale tasks first
  await cleanupTasks();

  const store = await loadTasks();
  const tasks = store.tasks;

  const now = Date.now();
  const formatAge = (createdAt: string) => {
    const ms = now - new Date(createdAt).getTime();
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
    return `${Math.round(ms / 86400000)}d ago`;
  };

  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    error: tasks.filter((t) => t.status === "error").length,
    recentTasks: tasks.slice(0, 5).map((t) => ({
      id: t.id,
      status: t.status,
      message: t.userMessage.slice(0, 60) + (t.userMessage.length > 60 ? "..." : ""),
      age: formatAge(t.createdAt),
    })),
  };
}
