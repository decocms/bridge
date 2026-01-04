/**
 * Two-Phase Agent Architecture
 *
 * Phase 1: ROUTER (fast model, meta-tools)
 * - Discovers available tools
 * - Explores files for context
 * - Creates execution plan
 *
 * Phase 2: EXECUTOR (smart model, specific tools)
 * - Runs the execution plan
 * - Has only the tools selected by router
 * - Executes and returns result
 */

import type { MeshClient, ToolDefinition, Message } from "./mesh-client.ts";
import { callMeshTool, getLLMConnectionId } from "./mesh-client.ts";
import { config } from "../config.ts";
import { createTask, updateTaskStatus, addTaskProgress, addToolUsed } from "./task-manager.ts";
import {
  getRouterSystemPrompt,
  createRouterTools,
  executeRouterTool,
  getConnections,
  getConnectionDetails,
  type ExecutionPlan,
  type RouterToolContext,
} from "./router-tools.ts";

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  /** Model for routing (fast/cheap) */
  fastModel: string;
  /** Model for execution (smart/capable) - defaults to fastModel */
  smartModel?: string;
  /** Max tokens for responses */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Max router iterations */
  maxRouterIterations?: number;
  /** Max executor iterations */
  maxExecutorIterations?: number;
  /** Callback when agent mode changes */
  onModeChange?: (mode: "FAST" | "SMART") => void;
  /** Callback for progress updates */
  onProgress?: (message: string) => void;
  /** Callback for events (like images) */
  sendEvent?: (event: string, data: Record<string, unknown>) => void;
}

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ============================================================================
// Agent Class
// ============================================================================

export class Agent {
  private meshClient: MeshClient;
  private localTools: LocalTool[];
  private config: AgentConfig;
  private currentMode: "FAST" | "SMART" = "FAST";
  private currentTaskId: string | null = null;

  constructor(meshClient: MeshClient, localTools: LocalTool[], agentConfig: AgentConfig) {
    this.meshClient = meshClient;
    this.localTools = localTools;
    this.config = {
      maxTokens: 2048,
      temperature: 0.7,
      maxRouterIterations: 10,
      maxExecutorIterations: 30,
      ...agentConfig,
    };
  }

  // ==========================================================================
  // Progress & Mode Tracking
  // ==========================================================================

  private sendProgress(message: string): void {
    this.config.onProgress?.(message);
    if (this.currentTaskId) {
      addTaskProgress(this.currentTaskId, message).catch(() => {});
    }
  }

  private trackToolUsed(toolName: string): void {
    if (this.currentTaskId) {
      addToolUsed(this.currentTaskId, toolName).catch(() => {});
    }
  }

  private setMode(mode: "FAST" | "SMART"): void {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
      this.config.onModeChange?.(mode);
    }
  }

  // ==========================================================================
  // Main Entry Point
  // ==========================================================================

  async run(userMessage: string, conversationHistory: Message[] = []): Promise<string> {
    console.error(
      `\n[FAST] ─── ${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}`,
    );

    // Create task for tracking
    const task = await createTask(userMessage);
    this.currentTaskId = task.id;

    this.sendProgress("🔍 Analyzing request...");
    this.setMode("FAST");

    try {
      const result = await this.runRouter(userMessage, conversationHistory);
      await updateTaskStatus(this.currentTaskId, "completed", result);
      this.currentTaskId = null;
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Agent] Fatal error: ${errorMsg}`);
      this.sendProgress(`❌ Error: ${errorMsg}`);

      if (this.currentTaskId) {
        await updateTaskStatus(this.currentTaskId, "error", undefined, errorMsg);
        this.currentTaskId = null;
      }

      return `Sorry, I encountered an error: ${errorMsg}`;
    }
  }

  // ==========================================================================
  // Phase 1: Router
  // ==========================================================================

  private async runRouter(userMessage: string, conversationHistory: Message[]): Promise<string> {
    const messages: Message[] = [
      { role: "system", content: getRouterSystemPrompt() },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ];

    const usedTools: string[] = [];
    const toolCallCounts = new Map<string, number>();
    const MAX_SAME_TOOL = 5;

    // Create router tool context
    const routerContext: RouterToolContext = {
      localTools: this.localTools,
      meshClient: this.meshClient,
      sendProgress: (msg) => this.sendProgress(msg),
      previousTools: usedTools,
      onExecuteTask: async (plan) => {
        this.setMode("SMART");
        const result = await this.runExecutor(plan, conversationHistory);
        this.setMode("FAST");
        return result;
      },
    };

    const routerTools = createRouterTools(
      this.localTools,
      this.meshClient,
      routerContext.onExecuteTask,
      routerContext.sendProgress,
      usedTools,
    );

    for (let i = 0; i < (this.config.maxRouterIterations || 10); i++) {
      const result = await this.callLLM(this.config.fastModel, messages, routerTools);

      // No tool calls = direct response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (usedTools.length > 0) {
          console.error(`[FAST] Tools used: ${usedTools.join(" → ")}`);
        }
        return result.text || "I couldn't generate a response.";
      }

      // Process tool calls
      for (const tc of result.toolCalls) {
        // Loop detection
        const callCount = (toolCallCounts.get(tc.name) || 0) + 1;
        toolCallCounts.set(tc.name, callCount);

        if (callCount > MAX_SAME_TOOL) {
          console.error(`[FAST] ⚠️ Skipping ${tc.name} (called ${callCount} times)`);
          messages.push({
            role: "user",
            content: `[Warning] You already called ${tc.name} ${callCount - 1} times. Use the results you have or respond to the user.`,
          });
          continue;
        }

        usedTools.push(tc.name);
        routerContext.previousTools = usedTools;

        const toolResult = await executeRouterTool(tc.name, tc.arguments, routerContext);

        // execute_task returns final response
        if (tc.name === "execute_task" && typeof toolResult === "string") {
          console.error(`[FAST] Tools used: ${usedTools.join(" → ")}`);
          return toolResult;
        }

        // Add result to messages
        messages.push({
          role: "assistant",
          content: result.text || `Calling ${tc.name}...`,
        });
        messages.push({
          role: "user",
          content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2)}`,
        });
      }
    }

    console.error(`[FAST] Tools used: ${usedTools.join(" → ")} (limit reached)`);
    return "I couldn't complete the request within the iteration limit.";
  }

  // ==========================================================================
  // Phase 2: Executor
  // ==========================================================================

  private async runExecutor(plan: ExecutionPlan, conversationHistory: Message[]): Promise<string> {
    const model = this.config.smartModel || this.config.fastModel;

    console.error(
      `\n[SMART] ─── Task: ${plan.task.slice(0, 60)}${plan.task.length > 60 ? "..." : ""}`,
    );
    console.error(`[SMART] Tools requested: ${plan.tools.map((t) => t.name).join(", ")}`);

    // Load the requested tools
    const loadedTools = await this.loadToolsForExecution(plan.tools);

    console.error(`[SMART] Available: ${loadedTools.map((t) => t.name).join(", ")}`);

    // Build executor prompt
    const executorPrompt = this.buildExecutorPrompt(plan);

    const messages: Message[] = [
      { role: "system", content: executorPrompt },
      ...conversationHistory.slice(-4),
      { role: "user", content: plan.task },
    ];

    const toolDefs = loadedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    let successfulCreates = 0;
    let lastSuccessfulCreate: string | null = null;

    // Loop detection
    let lastToolCall: string | null = null;
    let consecutiveRepeats = 0;
    const MAX_CONSECUTIVE_REPEATS = 3;

    for (let i = 0; i < (this.config.maxExecutorIterations || 30); i++) {
      const result = await this.callLLM(model, messages, toolDefs);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        const response = result.text || "Task completed.";
        this.sendProgress("✅ Done!");
        return response;
      }

      // Execute tool calls
      for (const tc of result.toolCalls) {
        const callSignature = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        if (callSignature === lastToolCall) {
          consecutiveRepeats++;
          if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
            console.error(`[SMART] ⚠️ Loop detected: ${tc.name} called ${consecutiveRepeats} times`);
            this.sendProgress(`⚠️ Stopped (loop detected)`);
            return `I got stuck in a loop calling ${tc.name}. The task may be partially complete.`;
          }
        } else {
          consecutiveRepeats = 1;
          lastToolCall = callSignature;
        }

        const toolDef = loadedTools.find((t) => t.name === tc.name);
        if (!toolDef) {
          messages.push({ role: "user", content: `[Tool Error]: Unknown tool ${tc.name}` });
          continue;
        }

        // Log
        const argsStr = this.formatArgsForLog(tc.arguments);
        console.error(`[SMART] → ${tc.name}(${argsStr})`);

        this.trackToolUsed(tc.name);
        this.sendProgress(`⚡ ${tc.name.replace("COLLECTION_", "").replace("_", " ")}...`);

        // Validate required params
        const schema = toolDef.inputSchema as { required?: string[] };
        const requiredParams = schema?.required || [];
        const missingParams = requiredParams.filter(
          (param) =>
            !(param in tc.arguments) ||
            tc.arguments[param] === undefined ||
            tc.arguments[param] === "",
        );

        if (missingParams.length > 0) {
          console.error(`[SMART] ✗ Missing: ${missingParams.join(", ")}`);
          messages.push({ role: "assistant", content: `Calling ${tc.name}...` });
          messages.push({
            role: "user",
            content: `[Tool Error for ${tc.name}]:\nMissing required parameters: ${missingParams.join(", ")}.`,
          });
          continue;
        }

        const startTime = Date.now();
        let toolResult: unknown;

        try {
          if (toolDef.source === "local") {
            const localTool = this.localTools.find((t) => t.name === tc.name);
            toolResult = localTool
              ? await localTool.execute(tc.arguments)
              : { error: "Local tool not found" };
          } else if (toolDef.source === "mesh" && toolDef.connectionId) {
            toolResult = await callMeshTool(toolDef.connectionId, tc.name, tc.arguments);
          } else {
            toolResult = { error: "Invalid tool configuration" };
          }

          const duration = Date.now() - startTime;
          console.error(`[SMART] ✓ ${tc.name} (${duration}ms)`);

          // Handle image results
          if (toolResult && typeof toolResult === "object") {
            const res = toolResult as Record<string, unknown>;
            if (res.image && typeof res.image === "string") {
              console.error(`[SMART] 🖼️ Image detected, sending directly`);
              this.sendProgress(`🖼️ Image generated!`);
              this.config.sendEvent?.("image_generated", { imageUrl: res.image });
              (toolResult as Record<string, unknown>).image = "[IMAGE DATA - sent to user]";
            }
          }

          // Track CREATE operations
          if (tc.name.includes("CREATE") && toolResult && typeof toolResult === "object") {
            const res = toolResult as Record<string, unknown>;
            if (!res.error && (res.item || res.id || res.success)) {
              successfulCreates++;
              lastSuccessfulCreate = tc.name;
              this.sendProgress(`✅ Created successfully!`);

              messages.push({ role: "assistant", content: `Calling ${tc.name}...` });
              messages.push({
                role: "user",
                content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2).slice(0, 3000)}\n\n✅ SUCCESS! The task is complete. Please provide a brief summary to the user.`,
              });
              continue;
            }
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(
            `[SMART] ✗ ${tc.name} (${duration}ms): ${error instanceof Error ? error.message : "Error"}`,
          );
          this.sendProgress(`❌ ${tc.name} failed`);
          toolResult = { error: error instanceof Error ? error.message : "Tool execution failed" };
        }

        messages.push({ role: "assistant", content: result.text || `Calling ${tc.name}...` });
        messages.push({
          role: "user",
          content: `[Tool Result for ${tc.name}]:\n${JSON.stringify(toolResult, null, 2).slice(0, 3000)}`,
        });
      }
    }

    this.sendProgress("⚠️ Reached iteration limit");
    if (lastSuccessfulCreate) {
      return `Task completed (${lastSuccessfulCreate} was successful), but the AI didn't provide a summary.`;
    }
    return "Task execution reached iteration limit without completing.";
  }

  // ==========================================================================
  // Tool Loading
  // ==========================================================================

  private async loadToolsForExecution(
    toolRequests: Array<{ name: string; source: string; connectionId?: string }>,
  ): Promise<Array<ToolDefinition & { source: string; connectionId?: string }>> {
    const loadedTools: Array<ToolDefinition & { source: string; connectionId?: string }> = [];
    const cachedConnections = await getConnections(this.meshClient);

    for (const req of toolRequests) {
      if (req.source === "local") {
        const tool = this.localTools.find((t) => t.name === req.name);
        if (tool) {
          loadedTools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: "local",
          });
        }
      } else if (req.source === "mesh") {
        let connectionId = req.connectionId;
        if (!connectionId) {
          const connWithTool = cachedConnections.find((c) =>
            c.tools.some((t) => t.name === req.name),
          );
          if (connWithTool) connectionId = connWithTool.id;
        }

        if (connectionId) {
          const details = await getConnectionDetails(connectionId);
          if (details) {
            const tool = details.tools.find((t) => t.name === req.name);
            if (tool) {
              loadedTools.push({
                name: tool.name,
                description: tool.description || "",
                inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                source: "mesh",
                connectionId,
              });
            }
          }
        }
      }
    }

    return loadedTools;
  }

  // ==========================================================================
  // Executor Prompt
  // ==========================================================================

  private buildExecutorPrompt(plan: ExecutionPlan): string {
    const allowedPaths =
      config.terminal.allowedPaths.length > 0
        ? config.terminal.allowedPaths.join(", ")
        : "/Users/guilherme/Projects/";

    let prompt = `You are a SMART EXECUTOR agent. You have been given a specific task and the tools to complete it.

**YOUR ROLE:**
You execute tasks step-by-step using the provided tools. You are capable, thorough, and complete the ENTIRE task before responding.

**TASK TO COMPLETE:**
${plan.task}

**CRITICAL INSTRUCTIONS:**
1. FOLLOW THE PLAN: Execute each step in the task description
2. USE TOOLS: Call tools via the function calling API (never simulate with XML/markdown)
3. COMPLETE THE TASK: Don't stop until ALL steps are done
4. BE THOROUGH: For content creation, write actual content (not placeholders)
5. SUMMARIZE: After completing all steps, provide a brief summary

**CONTENT CREATION RULES:**
When creating articles, blog posts, or content:
- Write engaging, complete content (500-2000 words)
- Use the tone/style from any TONE_OF_VOICE context
- Include a compelling title
- Set status to "draft" unless told otherwise
- The article should be publication-ready

**FILE EXPLORATION:**
- Allowed paths: ${allowedPaths}
- Use LIST_FILES to see folder contents
- Use READ_FILE to read specific files
- Explore project structure before writing about it`;

    if (plan.context) {
      prompt += `

**CONTEXT FROM PLANNING PHASE:**
${plan.context}`;
    }

    prompt += `

**WORKFLOW:**
1. Execute each step in the task
2. If exploring files, read the most relevant ones
3. If creating content, write actual high-quality content
4. Call the creation/action tools with complete data
5. Respond with a brief summary of what you accomplished

Match user's language (Portuguese if they wrote in PT, English if EN).`;

    return prompt;
  }

  // ==========================================================================
  // LLM Calling
  // ==========================================================================

  private async callLLM(
    modelId: string,
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<{
    text?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }> {
    const llmConnectionId = getLLMConnectionId();
    if (!llmConnectionId) {
      throw new Error("LLM binding not configured");
    }

    const prompt = messages.map((m) => {
      if (m.role === "system") {
        return { role: "system", content: m.content };
      }
      return { role: m.role, content: [{ type: "text", text: m.content }] };
    });

    const toolsForLLM = tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));

    const result = await callMeshTool<{
      content?: Array<{
        type: string;
        text?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        input?: string | Record<string, unknown>;
      }>;
      text?: string;
    }>(llmConnectionId, "LLM_DO_GENERATE", {
      modelId,
      callOptions: {
        prompt,
        tools: toolsForLLM.length > 0 ? toolsForLLM : undefined,
        toolChoice: toolsForLLM.length > 0 ? { type: "auto" as const } : undefined,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      },
    });

    // Extract text
    let text: string | undefined;
    if (result?.content) {
      const textPart = result.content.find((c) => c.type === "text");
      if (textPart?.text) text = textPart.text;
    }
    if (!text && result?.text) text = result.text;

    // Extract tool calls
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const toolCallParts = result?.content?.filter((c) => c.type === "tool-call") || [];

    for (const tc of toolCallParts) {
      let parsedArgs: Record<string, unknown> = {};
      if (tc.args && typeof tc.args === "object") {
        parsedArgs = tc.args;
      } else if (tc.input) {
        if (typeof tc.input === "string") {
          try {
            parsedArgs = JSON.parse(tc.input);
          } catch {
            // Use empty args
          }
        } else {
          parsedArgs = tc.input;
        }
      }

      if (tc.toolName) {
        toolCalls.push({ name: tc.toolName, arguments: parsedArgs });
      }
    }

    return { text, toolCalls };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private formatArgsForLog(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) {
      const parts = keys.map((k) => {
        const v = args[k];
        if (typeof v === "string") return `${k}:"${v.slice(0, 30)}${v.length > 30 ? "..." : ""}"`;
        if (typeof v === "number" || typeof v === "boolean") return `${k}:${v}`;
        return `${k}:<${typeof v}>`;
      });
      return parts.join(", ");
    }
    return keys.join(", ");
  }
}
