# mesh-bridge

**Turn any website into an MCP event stream.**

A Chrome extension that maps DOM events to MCP Event Bus messages. AI agents can subscribe to browser events and publish responses that appear on websites—all running locally on your machine.

```
┌──────────────────────────────────────────────────────────────────┐
│                          MCP MESH                                 │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                      EVENT BUS                            │    │
│  │                                                           │    │
│  │   user.message.received ◄── bridge publishes              │    │
│  │   agent.response.* ────────► bridge subscribes            │    │
│  │                                                           │    │
│  └──────────────────────────────────────────────────────────┘    │
│                               ▲                                   │
│                               │                                   │
│  ┌─────────────┐    ┌────────┴────────┐    ┌─────────────────┐   │
│  │   Agents    │    │  mesh-bridge    │    │   Other MCPs    │   │
│  │             │◄───│                 │───►│                 │   │
│  │  Subscribe  │    │  DOM ↔ Events   │    │  Can also       │   │
│  │  Process    │    │                 │    │  subscribe/     │   │
│  │  Respond    │    │  Domains:       │    │  publish        │   │
│  │             │    │  • WhatsApp ✅  │    │                 │   │
│  │             │    │  • CLI ✅       │    │                 │   │
│  └─────────────┘    └────────┬────────┘    └─────────────────┘   │
│                              │                                    │
└──────────────────────────────┼────────────────────────────────────┘
                               │ WebSocket
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼─────────────┐  ┌─────▼──────────────┐
│  Chrome Extension   │  │  CLI (terminal)    │
│                     │  │                    │
│  • Observes DOM     │  │  • bun run cli     │
│  • Injects AI text  │  │  • Monitor mode    │
│  • Per-site scripts │  │  • Same events     │
└─────────────────────┘  └────────────────────┘
```

## How It Works

1. **Extension** observes DOM events (new messages, clicks, navigation)
2. **Bridge** translates DOM events into Event Bus messages
3. **Agents** (or any MCP) subscribe to events and process them
4. **Responses** flow back through the bridge into the DOM

**The AI never sees the DOM.** It sees structured events like:

```typescript
{ type: "user.message.received", text: "Hello", source: "whatsapp", chatId: "self" }
```

## Quick Start

### 1. Add to Mesh

In MCP Mesh, add a new **Custom Command** connection:

| Field | Value |
|-------|-------|
| Name | `Mesh Bridge` |
| Type | `Custom Command` |
| Command | `bun` |
| Arguments | `run`, `start` |
| Working Directory | `/path/to/mesh-bridge` |

### 2. Install Extension

```bash
cd mesh-bridge
bun install
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/`

### 3. Open WhatsApp Web

Navigate to [web.whatsapp.com](https://web.whatsapp.com) and open your self-chat ("Message Yourself"). Send a message—the agent will respond!

## The WhatsApp Domain

The WhatsApp domain demonstrates the full pattern:

### DOM → Events

```javascript
// Content script observes new messages
new MutationObserver(() => {
  const lastMessage = getLastMessage();
  
  if (isNewUserMessage(lastMessage)) {
    socket.send(JSON.stringify({
      type: "message",
      domain: "whatsapp",
      text: lastMessage,
      chatId: getChatName()
    }));
  }
}).observe(messageContainer, { childList: true, subtree: true });
```

### Bridge → Event Bus

```typescript
// Server publishes to Event Bus
await callMeshTool(eventBusId, "EVENT_PUBLISH", {
  type: "user.message.received",
  data: {
    text: message.text,
    source: "whatsapp",
    chatId: message.chatId
  }
});
```

### Event Bus → DOM

```javascript
// Content script receives response
socket.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  
  if (frame.type === "send") {
    // Inject into WhatsApp input
    const input = document.querySelector('[data-testid="conversation-compose-box-input"]');
    input.focus();
    document.execCommand("insertText", false, frame.text);
    document.querySelector('[data-testid="send"]').click();
  }
};
```

## Event Types

### Bridge Publishes

```typescript
"user.message.received" {
  text: string;       // Message content
  source: string;     // "whatsapp", "linkedin", etc.
  chatId?: string;    // Conversation ID
  sender?: { name?: string };
}
```

### Bridge Subscribes To

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
  message: string;
}
```

**Any MCP** can subscribe to `user.message.*` or publish `agent.response.*` events.

## Adding a Domain

### Step 1: Content Script

Create `extension/domains/mysite/content.js`:

```javascript
const DOMAIN = "mysite";
let socket = new WebSocket("ws://localhost:9999");

socket.onopen = () => {
  socket.send(JSON.stringify({ type: "connect", domain: DOMAIN, url: location.href }));
};

// Observe DOM → publish events
new MutationObserver(() => {
  const data = extractFromDOM();
  if (data) {
    socket.send(JSON.stringify({ type: "message", domain: DOMAIN, ...data }));
  }
}).observe(document.body, { childList: true, subtree: true });

// Subscribe to responses → mutate DOM
socket.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  if (frame.type === "send") {
    injectIntoDom(frame.text);
  }
};
```

### Step 2: Server Handler

Create `server/domains/mysite/index.ts`:

```typescript
import type { Domain } from "../../core/domain.ts";

export const mysiteDomain: Domain = {
  id: "mysite",
  name: "My Site",
  urlPatterns: [/mysite\.com/],
  
  handleMessage: async (message, ctx) => {
    await publishEvent("user.message.received", {
      text: message.text,
      source: "mysite",
      chatId: message.chatId
    });
  }
};
```

### Step 3: Register

In `server/main.ts`:

```typescript
import { mysiteDomain } from "./domains/mysite/index.ts";
registerDomain(mysiteDomain);
```

### Step 4: Manifest

Add to `extension/manifest.json`:

```json
{
  "content_scripts": [
    {
      "matches": ["https://mysite.com/*"],
      "js": ["domains/mysite/content.js"]
    }
  ]
}
```

## Configuration

```bash
# WebSocket port (extension connects here)
WS_PORT=9999

# For standalone mode only
MESH_URL=http://localhost:3000
MESH_API_KEY=your-key
```

## File Structure

```
mesh-bridge/
├── cli/
│   └── index.ts          # Unified CLI + Server entry point
├── server/
│   ├── index.ts          # Auto-detect mode (stdio vs standalone)
│   ├── websocket.ts      # WebSocket server
│   ├── events.ts         # Event types
│   ├── core/
│   │   ├── protocol.ts   # Frame types
│   │   ├── mesh-client.ts
│   │   └── domain.ts     # Domain interface
│   └── domains/
│       ├── whatsapp/     # WhatsApp implementation
│       └── cli/          # CLI domain
├── extension/
│   ├── manifest.json
│   ├── background.js
│   └── domains/
│       └── whatsapp/
│           └── content.js
└── docs/
    └── ARCHITECTURE.md
```

## Development

```bash
# Run with hot reload (server + CLI)
bun dev

# Run tests
bun test

# Format code
bun run fmt

# Type check
bun run check
```

## Why Event-Driven?

| Approach | Tokens/interaction | Reliability |
|----------|-------------------|-------------|
| Screenshot + Vision | 1000-3000 | Fragile |
| DOM serialization | 2000-10000 | Fragile |
| **Event-based** | **50-100** | **Stable** |

Events are:
- **Small**: Structured data, not HTML noise
- **Stable**: Event types don't change when UI changes
- **Composable**: Any MCP can subscribe/publish

## Recent Updates

### Auto-Recovery from Extension Context Invalidation

Chrome's Manifest V3 suspends service workers after ~30 seconds of inactivity. Previously, this would break the extension when returning to a tab after being away.

**Now:** The content script monitors for context invalidation and automatically reloads the page when detected. No more "Extension context invalidated" errors requiring manual refresh.

### Thread Continuity

The bridge now works seamlessly with Pilot's thread management. Conversations within 5 minutes are treated as the same thread, enabling natural follow-ups like:

- "draft this" → continues from previous research
- "yes" / "continue" → proceeds to next workflow step
- "new thread" → starts fresh

## Privacy

- Runs **locally** on your machine
- Uses **your browser session** (no credential sharing)
- Only processes **self-chat** in WhatsApp (never private conversations)
- **Open source**—audit the code yourself

## Usage

The default `bun dev` runs both the WebSocket server (for browser extensions) AND an interactive CLI:

```bash
bun dev
```

```
╔════════════════════════════════════════════════════════════╗
║  🌐 MESH BRIDGE                                            ║
║  Universal Bridge for MCP Mesh                             ║
╚════════════════════════════════════════════════════════════╝

✓ Server started on port 9999
  Domains: whatsapp, cli

you ❯ what's the weather in SF?
07:24:59 → what's the weather in SF?
07:25:01 ⚡ perplexity search
07:25:03 🤖 San Francisco is currently 58°F with fog...
```

### Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/new` | Start new thread |
| `/monitor` | Toggle monitor mode (see all events) |
| `/status` | Show connection status |
| `/clients` | List connected WebSocket clients |
| `/quit` | Exit CLI |

### Script Variants

```bash
bun dev              # Server + interactive CLI (default)
bun dev:server       # Server only, no CLI (background mode)
bun dev:monitor      # Server + CLI with all-events monitoring
bun stdio            # STDIO mode (mesh-hosted, production)
bun dev:stdio        # STDIO mode with hot reload
```

### Monitor Mode

With `--monitor` flag or `/monitor` command, CLI shows **all** events from all sources:

```bash
bun dev --monitor
```

```
07:24:55 [wa] → run article research for AI agents    # WhatsApp message
07:24:57 [wa] ⚡ perplexity search
07:25:02 [wa] ← Started create-article-research
07:25:10 [cli] → list my tasks                        # Your CLI message
07:25:11 [cli] ← You have 3 active tasks...
```

## Domains

| Domain | Status | Description |
|--------|--------|-------------|
| WhatsApp | ✅ Ready | Self-chat AI interaction |
| CLI | ✅ Ready | Terminal interface |
| LinkedIn | 🔜 Planned | Messaging & networking |
| X/Twitter | 🔜 Planned | Compose, DMs |
| Gmail | 🔜 Planned | Compose, inbox |
| Custom | 📖 Guide | Add any site |

## License

MIT
