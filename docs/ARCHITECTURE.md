# Mesh Bridge Architecture

## Overview

Mesh Bridge is an **event-driven DOM-to-MCP adapter**. It translates browser events into MCP Event Bus messages, enabling AI agents to interact with any website.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              MCP MESH                                      │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │                         EVENT BUS                                   │   │
│  │                                                                     │   │
│  │    user.message.received ◄─── mesh-bridge publishes                │   │
│  │    agent.response.* ───────► mesh-bridge subscribes                │   │
│  │    agent.task.progress ────► mesh-bridge subscribes                │   │
│  │                                                                     │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────┐   │
│  │    Pilot Agent      │    │    mesh-bridge      │    │ Other MCPs   │   │
│  │    (mcps/pilot)     │    │                     │    │              │   │
│  │                     │    │  • Event publish    │    │ • OpenRouter │   │
│  │  Subscribes to:     │    │  • Event subscribe  │    │ • Perplexity │   │
│  │  user.message.*     │    │  • DOM ↔ WebSocket  │    │ • Writing    │   │
│  │                     │    │                     │    │              │   │
│  │  Publishes:         │    │  Domains:           │    │              │   │
│  │  agent.response.*   │    │  • WhatsApp         │    │              │   │
│  │  agent.task.*       │    │  • (more coming)    │    │              │   │
│  └─────────────────────┘    └──────────┬──────────┘    └──────────────┘   │
│                                        │                                   │
└────────────────────────────────────────┼───────────────────────────────────┘
                                         │ WebSocket (port 9999)
                                         ▼
                          ┌──────────────────────────────┐
                          │      Chrome Extension        │
                          │                              │
                          │  Content Script per domain:  │
                          │  • Observes DOM changes      │
                          │  • Sends events via WS       │
                          │  • Receives commands         │
                          │  • Mutates DOM accordingly   │
                          └──────────────────────────────┘
```

## Design Principles

### 1. Event-Driven, Not RPC

The bridge publishes events and subscribes to events. It doesn't call agents directly or wait for responses. This decouples the DOM layer from AI processing.

```typescript
// Bridge publishes user action
await publishEvent("user.message.received", {
  text: "hello",
  source: "whatsapp",
  chatId: "self"
});

// Agent responds via separate event (asynchronously)
// Bridge subscribes to agent.response.whatsapp
```

### 2. DOM Abstraction

Content scripts abstract messy DOM into clean events. The agent never sees HTML—only structured data.

```javascript
// Content script observes DOM
new MutationObserver((mutations) => {
  const newMessage = extractMessage(mutations);
  if (newMessage) {
    socket.send(JSON.stringify({
      type: "message",
      text: newMessage.text,
      chatId: newMessage.chatId
    }));
  }
}).observe(messageContainer, { childList: true });
```

### 3. Domain Plugins

Each website is a "domain" with its own:
- URL patterns (when to activate)
- Event handlers (what to do with messages)
- DOM knowledge (in content script)

```typescript
export const whatsappDomain: Domain = {
  id: "whatsapp",
  urlPatterns: [/whatsapp\.com/],
  handleMessage: async (msg, ctx) => {
    await publishEvent("user.message.received", {
      text: msg.text,
      source: "whatsapp",
      chatId: msg.chatId
    });
  }
};
```

## Components

### Server (`server/`)

| File | Purpose |
|------|---------|
| `index.ts` | Entry point (auto-detects STDIO vs standalone) |
| `stdio.ts` | MCP STDIO transport (runs inside Mesh) |
| `main.ts` | Standalone mode entry point |
| `websocket.ts` | WebSocket server for extensions |
| `config.ts` | Configuration loading |
| `events.ts` | Event type definitions |

### Core (`server/core/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | WebSocket frame types (connect, message, send, etc.) |
| `mesh-client.ts` | MCP Mesh API client |
| `domain.ts` | Domain interface and registry |

### Domains (`server/domains/`)

| Domain | Status | Description |
|--------|--------|-------------|
| `whatsapp/` | ✅ Ready | Self-chat AI interaction |

### Extension (`extension/`)

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome extension config |
| `background.js` | Service worker |
| `domains/whatsapp/content.js` | WhatsApp content script |

## Event Flow

### User Message → Agent Response

```
1. User types in WhatsApp Web
   ↓
2. Content script detects via MutationObserver
   ↓
3. Content script → WebSocket → Bridge server
   { type: "message", text: "hello", chatId: "self" }
   ↓
4. Bridge publishes to Event Bus
   EVENT_PUBLISH("user.message.received", { text, source: "whatsapp", chatId })
   ↓
5. Pilot agent (subscribed) receives event
   ↓
6. Pilot processes, publishes response
   EVENT_PUBLISH("agent.response.whatsapp", { text: "Hi!", chatId })
   ↓
7. Bridge (subscribed) receives via ON_EVENTS tool
   ↓
8. Bridge → WebSocket → Content script
   { type: "send", text: "🤖 Hi!", chatId }
   ↓
9. Content script injects into WhatsApp input & clicks send
```

## Event Types

### Published by Bridge

```typescript
"user.message.received" {
  text: string;          // Message content
  source: string;        // "whatsapp", "linkedin", etc.
  chatId?: string;       // Conversation identifier
  sender?: {             // Sender info
    id?: string;
    name?: string;
  };
  metadata?: Record<string, unknown>;
}
```

### Subscribed by Bridge

```typescript
"agent.response.whatsapp" {
  taskId: string;
  chatId?: string;
  text: string;
  imageUrl?: string;
  isFinal: boolean;
}

"agent.task.progress" {
  taskId: string;
  source: string;
  chatId?: string;
  message: string;
  percent?: number;
}

"agent.task.completed" {
  taskId: string;
  source: string;
  chatId?: string;
  response: string;
  duration: number;
  toolsUsed: string[];
}
```

## WebSocket Protocol

### Client → Bridge

| Frame Type | Purpose |
|------------|---------|
| `connect` | Establish session, declare domain |
| `message` | User message for processing |
| `command` | Slash commands |
| `event` | Domain-specific events |
| `ping` | Heartbeat |

### Bridge → Client

| Frame Type | Purpose |
|------------|---------|
| `connected` | Session confirmation |
| `send` | Text to inject into page |
| `send_image` | Image to inject |
| `response` | Command response |
| `error` | Error handling |
| `pong` | Heartbeat response |
| `processing_started/ended` | Loading states |
| `agent_progress` | Progress updates |

## Adding a New Domain

1. **Create server handler** (`server/domains/mysite/index.ts`):
   - Define URL patterns
   - Implement `handleMessage` to publish events
   - Export as `Domain`

2. **Create content script** (`extension/domains/mysite/content.js`):
   - Connect to WebSocket
   - Set up DOM observers
   - Handle incoming commands

3. **Register domain** (in `server/main.ts`)
4. **Update manifest** (`extension/manifest.json`)

See [README.md](../README.md) for detailed examples.

## Running Modes

### STDIO Mode (Recommended)

Mesh spawns the bridge as a child process:

```
Mesh → STDIO → mesh-bridge → WebSocket → Extension
```

- Credentials passed via environment
- No API key needed
- Automatic lifecycle management

### Standalone Mode

Bridge runs independently:

```
mesh-bridge → HTTP → Mesh API
```

- Requires `MESH_API_KEY`
- Manual startup
- Useful for development
