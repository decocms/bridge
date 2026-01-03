# mesh-bridge

**Universal browser bridge for MCP Mesh—control any website through AI.**

A Chrome extension and local server that connects websites to your MCP Mesh. Define **domains** (WhatsApp, LinkedIn, X, etc.) with custom message handlers and tools. Works like **RPA for any website**, powered by AI.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Mesh (port 3000)                        │
│  OpenRouter · Perplexity · Custom MCPs · Your Tools             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ STDIO (mesh starts the process)
┌──────────────────────────────┴──────────────────────────────────┐
│                   MESH BRIDGE                                    │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐      │
│  │  WhatsApp   │  LinkedIn   │      X      │    ...      │      │
│  │  (domain)   │  (domain)   │  (domain)   │  (any site) │      │
│  └─────────────┴─────────────┴─────────────┴─────────────┘      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ WebSocket (port 9999)
              Chrome Extension (injects into websites)
```

### Dual Communication

- **Mesh → Bridge**: STDIO (when mesh starts the process)
  - Receives `MESH_REQUEST_CONTEXT` with auth token
  - Can call any mesh tool without API key
  
- **Bridge → Extension**: WebSocket (port 9999)
  - Extension connects and declares its domain
  - Messages flow through domain handlers
  - AI responses sent back to the website

## How It Works

1. **Extension** injects into websites and connects to mesh-bridge
2. **Bridge** matches the URL to a **domain** (e.g., WhatsApp)
3. **Domain** handles messages, transforms them into mesh commands
4. **Mesh** executes tools (LLM, terminal, search, etc.)
5. **Response** flows back through the domain to the website

## Domains

Domains are plugins that define how to interact with a specific website:

```typescript
const myDomain: Domain = {
  id: "linkedin",
  name: "LinkedIn",
  urlPatterns: [/^https?:\/\/(www\.)?linkedin\.com/],
  
  // Handle incoming messages
  handleMessage: async (message, ctx) => {
    const response = await ctx.meshClient.generateWithLLM(
      "anthropic/claude-sonnet-4",
      [{ role: "user", content: message.text }],
    );
    ctx.send({ type: "send", id: message.id, chatId: message.chatId, text: response });
  },
  
  // Domain-specific tools
  tools: [
    {
      name: "SEND_MESSAGE",
      description: "Send a LinkedIn message",
      execute: async (input, ctx) => { /* ... */ },
    },
  ],
};
```

### Current Domains

| Domain | Status | Description |
|--------|--------|-------------|
| WhatsApp | ✅ Ready | Message yourself to chat with AI |
| LinkedIn | 🔜 Planned | AI-powered messaging and networking |
| X (Twitter) | 🔜 Planned | Compose tweets, manage DMs |
| Any Site | 🛠️ RPA | Add a domain for any website! |

## Quick Start

### Option 1: Add to Mesh (Recommended)

Add mesh-bridge as a **Custom Command** connection in your mesh:

| Field | Value |
|-------|-------|
| **Name** | `Mesh Bridge` |
| **Type** | `Custom Command` |
| **Command** | `bun` |
| **Arguments** | `run server` |
| **Working Directory** | `/path/to/mesh-bridge` |

The mesh will:
1. Start the server automatically via STDIO
2. Pass authentication context (no API key needed!)
3. Keep it running as long as mesh is running

Then load the extension:
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/`
4. Navigate to WhatsApp Web

### Option 2: Standalone (Manual)

If you prefer to run mesh-bridge separately:

```bash
cd mesh-bridge
bun install

# Configure (only needed for standalone mode)
cp .env.example .env
# Set MESH_API_KEY in .env

# Run
bun run server
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show commands |
| `/status` | Check mesh + domain status |
| `/tools` | List mesh tools |
| `/domains` | List available domains |
| `/clear` | Clear conversation |

## Configuration

```env
# Mesh connection
MESH_URL=http://localhost:3000
MESH_API_KEY=...  # Optional if running inside mesh

# Default AI model
DEFAULT_MODEL=anthropic/claude-sonnet-4

# Server port
WS_PORT=9999

# Terminal safety
ALLOWED_PATHS=/Users/you/Projects
```

## Adding a New Domain

Follow these steps to add support for a new website. This works for **any website**—think of it as AI-powered RPA.

### Step 1: Create the Domain Handler

Create `server/domains/mydomain/index.ts`:

```typescript
import type { Domain, DomainMessage, DomainContext, DomainTool } from "../../core/domain.ts";

// System prompt for AI interactions in this domain
const SYSTEM_PROMPT = `You are an AI assistant integrated with MyDomain.
Keep responses concise and helpful.`;

// Domain-specific tools (optional)
const tools: DomainTool[] = [
  {
    name: "SEND_MESSAGE",
    description: "Send a message in MyDomain",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string" },
        text: { type: "string" },
      },
      required: ["chatId", "text"],
    },
    execute: async (input, ctx) => {
      const { chatId, text } = input as { chatId: string; text: string };
      ctx.send({ type: "send", id: `tool-${Date.now()}`, chatId, text });
      return { success: true };
    },
  },
];

// Message handler
async function handleMessage(message: DomainMessage, ctx: DomainContext): Promise<void> {
  const { meshClient, session, send, config } = ctx;
  
  // Get conversation history
  let conversation = session.conversations.get(message.chatId) || [];
  
  // Build messages for LLM
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...conversation.map((c) => ({ role: c.role, content: c.content })),
    { role: "user" as const, content: message.text },
  ];
  
  // Generate AI response via mesh
  const response = await meshClient.generateWithLLM(
    config.defaultModel || "anthropic/claude-sonnet-4",
    messages,
    { maxTokens: 2048 },
  );
  
  // Update conversation history
  conversation.push({ role: "user", content: message.text, timestamp: new Date() });
  conversation.push({ role: "assistant", content: response, timestamp: new Date() });
  session.conversations.set(message.chatId, conversation.slice(-20));
  
  // Send response back to the website
  send({
    type: "send",
    id: message.id,
    chatId: message.chatId,
    text: `🤖 ${response}`,
  });
}

// Export the domain
export const myDomain: Domain = {
  id: "mydomain",
  name: "My Domain",
  description: "AI assistant for MyDomain",
  icon: "https://example.com/icon.png",
  
  // URL patterns to match
  urlPatterns: [
    /^https?:\/\/(www\.)?example\.com/,
  ],
  
  systemPrompt: SYSTEM_PROMPT,
  tools,
  handleMessage,
  
  // Optional: handle slash commands
  handleCommand: async (command, args, ctx) => {
    if (command === "/mycommand") {
      return { handled: true, response: "🤖 Custom command response" };
    }
    return { handled: false };
  },
  
  // Optional: lifecycle hooks
  onInit: async (ctx) => {
    console.log(`[mydomain] Initialized for session ${ctx.session.id}`);
  },
  onDestroy: async (ctx) => {
    console.log(`[mydomain] Session ended`);
  },
};

export default myDomain;
```

### Step 2: Register the Domain

In `server/main.ts`, import and register your domain:

```typescript
// Import domains
import { whatsappDomain } from "./domains/whatsapp/index.ts";
import { myDomain } from "./domains/mydomain/index.ts";  // Add this

// Register domains
registerDomain(whatsappDomain);
registerDomain(myDomain);  // Add this
```

### Step 3: Create the Content Script

Create `extension/domains/mydomain/content.js`:

```javascript
/**
 * MyDomain - Content Script
 */

const DOMAIN_ID = "mydomain";
const BRIDGE_URL = "ws://localhost:9999";

let socket = null;
let connected = false;

// Connect to mesh-bridge
function connect() {
  socket = new WebSocket(BRIDGE_URL);
  
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "connect",
      client: "chrome-extension",
      version: "1.0.0",
      domain: DOMAIN_ID,
      url: window.location.href,
    }));
  };
  
  socket.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    
    if (frame.type === "connected") {
      connected = true;
      console.log(`[${DOMAIN_ID}] Connected to mesh-bridge`);
    }
    
    if (frame.type === "send") {
      // Inject the AI response into the page
      injectMessage(frame.chatId, frame.text);
    }
  };
  
  socket.onclose = () => {
    connected = false;
    setTimeout(connect, 5000);  // Reconnect
  };
}

// Send message to bridge for AI processing
function sendToBridge(text, chatId) {
  if (!connected) return;
  
  socket.send(JSON.stringify({
    type: "message",
    id: `msg-${Date.now()}`,
    domain: DOMAIN_ID,
    text,
    chatId,
    isSelf: true,
    timestamp: Date.now(),
  }));
}

// Inject AI response into the page (customize for your domain)
function injectMessage(chatId, text) {
  // TODO: Implement for your specific website
  console.log(`[${DOMAIN_ID}] Would send: ${text}`);
}

// Observe for new messages (customize for your domain)
function observeMessages() {
  // TODO: Set up MutationObserver for your specific website
}

// Initialize
connect();
observeMessages();
```

### Step 4: Update the Manifest

Add your domain to `extension/manifest.json`:

```json
{
  "content_scripts": [
    {
      "matches": ["https://web.whatsapp.com/*"],
      "js": ["domains/whatsapp/content.js"],
      "css": ["panel.css"]
    },
    {
      "matches": ["https://example.com/*"],
      "js": ["domains/mydomain/content.js"],
      "css": ["panel.css"]
    }
  ],
  "host_permissions": [
    "https://web.whatsapp.com/*",
    "https://example.com/*"
  ]
}
```

### Step 5: Test

1. Restart the server: `bun run server`
2. Reload the extension in `chrome://extensions`
3. Navigate to your domain's website
4. Check the console for connection logs
5. Try sending a message!

### Domain Interface Reference

```typescript
interface Domain {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  description: string;           // What it does
  icon?: string;                 // Icon URL
  urlPatterns: RegExp[];         // URLs to match
  
  // Required: handle incoming messages
  handleMessage: (message: DomainMessage, ctx: DomainContext) => Promise<void>;
  
  // Optional: handle slash commands
  handleCommand?: (command: string, args: string[], ctx: DomainContext) 
    => Promise<{ handled: boolean; response?: string }>;
  
  // Optional: domain-specific tools exposed to mesh
  tools?: DomainTool[];
  
  // Optional: system prompt for AI
  systemPrompt?: string;
  
  // Optional: lifecycle hooks
  onInit?: (ctx: DomainContext) => Promise<void>;
  onDestroy?: (ctx: DomainContext) => Promise<void>;
}
```

## API

### DomainContext

Passed to all domain handlers:

```typescript
interface DomainContext {
  meshClient: MeshClient;  // Call mesh tools
  session: Session;        // Session state
  send: (frame) => void;   // Send response
  config: DomainConfig;    // Domain config
}
```

### MeshClient

```typescript
// Call any mesh tool
await ctx.meshClient.callTool("TOOL_NAME", { arg: "value" });

// Generate LLM response
await ctx.meshClient.generateWithLLM(model, messages, options);

// List available tools
await ctx.meshClient.listTools();
```

## License

MIT
