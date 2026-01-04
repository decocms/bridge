# Mesh Bridge Architecture

## Event-Driven Design

The Mesh Bridge has been refactored to use an event-driven architecture with the MCP Mesh event bus. This separates concerns cleanly:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              MCP MESH                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │     PILOT        │    │    EVENT BUS     │    │   mesh-bridge    │  │
│  │   (mcps/pilot)   │◄──►│                  │◄──►│                  │  │
│  │                  │    │ user.message.*   │    │ • WhatsApp domain│  │
│  │ • FAST Router    │    │ agent.task.*     │    │ • DOM ↔ Tools    │  │
│  │ • SMART Executor │    │ agent.response.* │    │ • Event publish  │  │
│  │ • Task Manager   │    │                  │    │                  │  │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket
                                    ▼
                          ┌──────────────────┐
                          │ Chrome Extension │
                          │                  │
                          │ • WhatsApp Web   │
                          │ • Content Script │
                          └──────────────────┘
```

## Components

### 1. Pilot (`mcps/pilot/`)

The intelligent AI agent that:
- Subscribes to `user.message.received` events
- Uses FAST/SMART dual-phase architecture for task planning and execution
- Manages task history and progress
- Publishes `agent.task.*` and `agent.response.*` events
- Can control your computer (files, shell, notifications, speech)
- Knows about all tools in the mesh

**Tools exposed:**
- `PROCESS_MESSAGE` - Main entry point for any message
- `LIST_TASKS` - List recent tasks
- `GET_TASK` - Get task details
- `CANCEL_TASK` - Cancel a task
- `ON_EVENTS` - Receive events from mesh

### 2. Mesh Bridge (`mesh-bridge/`)

A thin layer that:
- Maps DOM ↔ MCP Tools (domain scripts)
- Publishes `user.message.received` events
- Subscribes to `agent.response.whatsapp` events
- Renders responses to the appropriate interface

**No agent logic** - just event publishing and rendering.

### 3. Chrome Extension

Content scripts that:
- Intercept user messages from WhatsApp Web
- Send them to the bridge via WebSocket
- Render AI responses back to the chat

## Event Types

### User → Agent (Bridge → Pilot)

```typescript
// User sent a message
"user.message.received" {
  text: string;
  source: "whatsapp" | "cli" | ...;
  chatId?: string;
  sender?: { id?: string; name?: string };
}
```

### Agent → User (Pilot → Bridge)

```typescript
// Task progress
"agent.task.progress" {
  taskId: string;
  source: string;
  chatId?: string;
  message: string;
}

// Task completed
"agent.task.completed" {
  taskId: string;
  source: string;
  chatId?: string;
  response: string;
  duration: number;
  toolsUsed: string[];
}

// Response for specific interface
"agent.response.whatsapp" {
  taskId: string;
  source: string;
  chatId?: string;
  text: string;
  imageUrl?: string;
  isFinal: boolean;
}
```

## Benefits

1. **Separation of Concerns**
   - Bridge: DOM ↔ Tools mapping
   - Pilot: AI orchestration and task management

2. **Interface Agnostic**
   - Same Pilot agent can be used from WhatsApp, CLI, Raycast, etc.
   - Just publish to `user.message.received`

3. **Resilient**
   - Events queue if Pilot is temporarily unavailable
   - Progress updates via events (no tight coupling)

4. **Scalable**
   - Multiple bridges can publish to the same Pilot
   - Multiple Pilots could subscribe to different event types

## Development

### Running Pilot

```bash
cd mcps/pilot
bun install
bun run dev
```

### Running Bridge

```bash
cd mesh-bridge
bun install
bun run dev
```

### Testing

```bash
# Pilot tests
cd mcps/pilot && bun test

# Bridge tests
cd mesh-bridge && bun test
```

