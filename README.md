# mesh-bridge

**Connect any website to MCP Mesh via the Event Bus.**

A Chrome extension that maps DOM events to MCP Event Bus pub/sub—enabling AI agents to interact with any website. Think RPA, but powered by events and AI.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP MESH                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      EVENT BUS                             │  │
│  │                                                            │  │
│  │   user.message.received ───────►  agent.response.whatsapp  │  │
│  │   (Bridge publishes)              (Agent publishes)        │  │
│  │                                                            │  │
│  └─────────────▲─────────────────────────────┬───────────────┘  │
│                │                             │                   │
│                │ SUBSCRIBE                   │ PUBLISH           │
│                │                             │                   │
│  ┌─────────────┴───────┐           ┌────────▼────────────┐      │
│  │       Pilot         │           │    mesh-bridge      │      │
│  │    (AI Agent)       │           │  (DOM ↔ Events)     │      │
│  │                     │           │                     │      │
│  │  Subscribes to:     │           │  Subscribes to:     │      │
│  │  user.message.*     │           │  agent.response.*   │      │
│  │                     │           │  agent.task.*       │      │
│  │  Publishes:         │           │                     │      │
│  │  agent.response.*   │           │  Publishes:         │      │
│  │  agent.task.*       │           │  user.message.*     │      │
│  └─────────────────────┘           └──────────┬──────────┘      │
│                                               │                  │
└───────────────────────────────────────────────┼──────────────────┘
                                                │ WebSocket
                              ┌─────────────────▼─────────────────┐
                              │        Chrome Extension           │
                              │                                   │
                              │  DOM Observation ──► Event Publish│
                              │  Event Subscribe ──► DOM Mutation │
                              │                                   │
                              │  Example: WhatsApp Web            │
                              │  • New message → publish event    │
                              │  • Response event → inject reply  │
                              └───────────────────────────────────┘
```

## Core Concept: DOM ↔ Event Bus Mapping

The bridge is a thin layer that translates between:
- **DOM events** (user types, clicks, new elements appear)
- **Event Bus messages** (CloudEvents pub/sub)

It has **no AI logic**—agents subscribe to events and respond via events.

### Example: WhatsApp Domain

```javascript
// 1. OBSERVE DOM → PUBLISH EVENT
// When user sends a message in WhatsApp...

const observer = new MutationObserver(() => {
  const lastMessage = getLastMessage(); // Extract from DOM
  
  if (isNewUserMessage(lastMessage)) {
    // Publish to Event Bus via WebSocket → Bridge → Mesh
    socket.send(JSON.stringify({
      type: "message",
      domain: "whatsapp",
      text: lastMessage.text,
      chatId: getChatName(),
    }));
  }
});

observer.observe(messageContainer, { childList: true, subtree: true });
```

```javascript
// 2. SUBSCRIBE TO EVENTS → MUTATE DOM
// When agent responds...

socket.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  
  if (frame.type === "send") {
    // Inject response into WhatsApp's input and send
    const input = document.querySelector('[data-testid="conversation-compose-box-input"]');
    input.focus();
    document.execCommand("insertText", false, frame.text);
    document.querySelector('[data-testid="send"]').click();
  }
};
```

## Event Types

### Bridge → Agent (Publishing)

```typescript
// User sent a message via any interface
"user.message.received" {
  text: "What's the weather like?",
  source: "whatsapp",      // or "linkedin", "x", "slack"...
  chatId: "John Doe",
  sender: { name: "John" },
  metadata: { /* interface-specific data */ }
}
```

### Agent → Bridge (Subscribing)

```typescript
// Task progress updates
"agent.task.progress" {
  taskId: "abc123",
  source: "whatsapp",
  message: "Checking weather API...",
  percent: 50
}

// Final response
"agent.response.whatsapp" {
  taskId: "abc123",
  chatId: "John Doe",
  text: "It's 72°F and sunny ☀️",
  isFinal: true
}

// Task completed
"agent.task.completed" {
  taskId: "abc123",
  response: "It's 72°F and sunny",
  duration: 2340,
  toolsUsed: ["WEATHER_API"]
}
```

## Quick Start

### 1. Add to Mesh

Add mesh-bridge as a **Custom Command** connection:

| Field | Value |
|-------|-------|
| **Name** | `Mesh Bridge` |
| **Type** | `Custom Command` |
| **Command** | `bun` |
| **Arguments** | `run server` |
| **Working Directory** | `/path/to/mesh-bridge` |

The mesh will start the bridge and pass authentication context.

### 2. Load the Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/`
4. Navigate to WhatsApp Web

### 3. Test It

Send yourself a message in WhatsApp. The bridge will:
1. Detect the new message (DOM observation)
2. Publish `user.message.received` event
3. Pilot agent receives and processes it
4. Agent publishes `agent.response.whatsapp`
5. Bridge receives and injects response into chat

## Creating a Domain

A domain defines how to map a specific website's DOM to events.

### Step 1: Content Script (DOM ↔ WebSocket)

Create `extension/domains/linkedin/content.js`:

```javascript
const DOMAIN_ID = "linkedin";
const BRIDGE_URL = "ws://localhost:9999";

let socket = null;

// ============================================================================
// CONNECTION
// ============================================================================

function connect() {
  socket = new WebSocket(BRIDGE_URL);
  
  socket.onopen = () => {
    // Announce our domain to the bridge
    socket.send(JSON.stringify({
      type: "connect",
      domain: DOMAIN_ID,
      url: window.location.href,
      capabilities: ["messages", "notifications"],
    }));
  };
  
  socket.onmessage = handleServerMessage;
  socket.onclose = () => setTimeout(connect, 5000);
}

// ============================================================================
// DOM → EVENTS (Publishing)
// ============================================================================

function observeMessages() {
  // Find LinkedIn's message container
  const container = document.querySelector('.msg-overlay-list-bubble');
  if (!container) {
    setTimeout(observeMessages, 1000);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.classList?.contains('msg-s-message-list__event')) {
          const text = node.querySelector('.msg-s-event-listitem__body')?.innerText;
          const sender = node.querySelector('.msg-s-message-group__name')?.innerText;
          
          if (text && isFromOther(node)) {
            // Publish user message event
            socket.send(JSON.stringify({
              type: "message",
              domain: DOMAIN_ID,
              text,
              chatId: getCurrentChatId(),
              sender: { name: sender },
            }));
          }
        }
      }
    }
  });

  observer.observe(container, { childList: true, subtree: true });
}

// ============================================================================
// EVENTS → DOM (Subscribing)
// ============================================================================

function handleServerMessage(event) {
  const frame = JSON.parse(event.data);
  
  switch (frame.type) {
    case "connected":
      console.log(`[${DOMAIN_ID}] Connected to bridge`);
      observeMessages();
      break;
      
    case "send":
      // Agent wants to send a response
      injectMessage(frame.chatId, frame.text);
      break;
      
    case "navigate":
      // Agent wants to navigate to a profile/page
      window.location.href = frame.url;
      break;
      
    case "click":
      // Agent wants to click something
      document.querySelector(frame.selector)?.click();
      break;
  }
}

function injectMessage(chatId, text) {
  const input = document.querySelector('.msg-form__contenteditable');
  if (!input) return;
  
  input.focus();
  document.execCommand("insertText", false, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  
  // Click send
  setTimeout(() => {
    document.querySelector('.msg-form__send-button')?.click();
  }, 100);
}

// ============================================================================
// HELPERS
// ============================================================================

function getCurrentChatId() {
  return document.querySelector('.msg-overlay-bubble-header__title')?.innerText || 'unknown';
}

function isFromOther(node) {
  return !node.classList.contains('msg-s-message-list__event--sent');
}

// Start
connect();
```

### Step 2: Server Domain Handler

Create `server/domains/linkedin/index.ts`:

```typescript
import type { Domain, DomainMessage, DomainContext } from "../../core/domain.ts";
import { EVENT_TYPES } from "../../events.ts";

export const linkedinDomain: Domain = {
  id: "linkedin",
  name: "LinkedIn",
  urlPatterns: [/^https?:\/\/(www\.)?linkedin\.com/],
  
  // Transform incoming WebSocket message to Event Bus event
  async handleMessage(message: DomainMessage, ctx: DomainContext) {
    // Publish to event bus - Pilot will pick it up
    await ctx.meshClient.callTool("EVENT_PUBLISH", {
      type: EVENT_TYPES.USER_MESSAGE,
      data: {
        text: message.text,
        source: "linkedin",
        chatId: message.chatId,
        sender: message.sender,
      },
    });
    
    // Progress and responses come via event subscriptions
    // The bridge auto-routes them back to this domain
  },
  
  // Domain-specific tools (optional)
  tools: [
    {
      name: "LINKEDIN_PROFILE",
      description: "Get current LinkedIn profile info",
      execute: async (input, ctx) => {
        // Request profile data from content script
        ctx.send({ type: "request_profile" });
        // Response comes via event
        return { success: true, message: "Profile requested" };
      },
    },
  ],
};
```

### Step 3: Register Domain

In `server/main.ts`:

```typescript
import { linkedinDomain } from "./domains/linkedin/index.ts";

registerDomain(linkedinDomain);
```

### Step 4: Update Manifest

In `extension/manifest.json`:

```json
{
  "content_scripts": [
    {
      "matches": ["https://www.linkedin.com/*"],
      "js": ["domains/linkedin/content.js"]
    }
  ]
}
```

## Common DOM → Event Patterns

### Pattern 1: Message Observer

```javascript
// Observe new messages and publish events
function observeMessages() {
  const container = document.querySelector(MESSAGES_SELECTOR);
  
  new MutationObserver((mutations) => {
    const newMessages = extractNewMessages(mutations);
    
    for (const msg of newMessages) {
      if (shouldProcess(msg)) {
        publishEvent("user.message.received", {
          text: msg.text,
          source: DOMAIN_ID,
          chatId: msg.chatId,
        });
      }
    }
  }).observe(container, { childList: true, subtree: true });
}
```

### Pattern 2: Click Events

```javascript
// Track button clicks and publish events
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-action]");
  if (button) {
    publishEvent("user.action.click", {
      action: button.dataset.action,
      source: DOMAIN_ID,
      context: extractContext(button),
    });
  }
});
```

### Pattern 3: Form Submissions

```javascript
// Intercept form submissions
document.addEventListener("submit", (e) => {
  const form = e.target;
  const formData = new FormData(form);
  
  publishEvent("user.action.submit", {
    formId: form.id,
    data: Object.fromEntries(formData),
    source: DOMAIN_ID,
  });
});
```

### Pattern 4: Page Navigation

```javascript
// Observe URL changes (for SPAs)
let lastUrl = location.href;

new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    publishEvent("user.navigation", {
      url: location.href,
      source: DOMAIN_ID,
    });
  }
}).observe(document, { subtree: true, childList: true });
```

## Common Event → DOM Patterns

### Pattern 1: Inject Text

```javascript
// Insert AI response into an input
function handleSendResponse(frame) {
  const input = document.querySelector(INPUT_SELECTOR);
  input.focus();
  document.execCommand("insertText", false, frame.text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
```

### Pattern 2: Click Element

```javascript
// Click a button on behalf of agent
function handleClick(frame) {
  const element = document.querySelector(frame.selector);
  if (element) {
    element.click();
  }
}
```

### Pattern 3: Show Notification

```javascript
// Display agent feedback in the UI
function handleNotification(frame) {
  const toast = document.createElement("div");
  toast.className = "mesh-bridge-toast";
  toast.textContent = frame.message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
```

### Pattern 4: Navigate

```javascript
// Navigate to a different page
function handleNavigate(frame) {
  window.location.href = frame.url;
}
```

## Available Domains

| Domain | Status | Description |
|--------|--------|-------------|
| WhatsApp | ✅ Ready | Chat with AI via self-messages |
| LinkedIn | 🔜 Planned | AI-powered messaging |
| X (Twitter) | 🔜 Planned | Tweet composition, DMs |
| Slack | 🔜 Planned | Workspace integration |
| Any Site | 🛠️ RPA | Add your own domain! |

## Configuration

```env
# WebSocket port for extension connection
WS_PORT=9999

# Default AI model (used by agents)
DEFAULT_MODEL=anthropic/claude-sonnet-4

# Mesh connection (automatic when run via Mesh)
MESH_URL=http://localhost:3000
MESH_API_KEY=...  # Optional if running inside mesh
```

## Development

```bash
# Install dependencies
bun install

# Run the bridge server
bun run server

# Run tests
bun test
```

## See Also

- [Architecture](docs/ARCHITECTURE.md) - Detailed architecture overview
- [MCP Mesh Event Bus](https://github.com/decolabs/mesh) - Event bus documentation
- [Pilot Agent](../mcps/pilot) - AI agent that processes events

## License

MIT
