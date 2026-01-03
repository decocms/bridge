# mesh-bridge

> Universal browser bridge for MCP Mesh—control any website through AI.

## Vision

**One bridge, many domains.** mesh-bridge connects browser extensions to your MCP Mesh, with pluggable **domains** that define how to interact with specific websites.

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Mesh (port 3000)                        │
│  OpenRouter · Perplexity · Custom MCPs · Tools · Gateways       │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────┐
│                   MESH BRIDGE (port 9999)                        │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐      │
│  │  WhatsApp   │  LinkedIn   │      X      │    ...      │      │
│  │  (domain)   │  (domain)   │  (domain)   │  (any site) │      │
│  └─────────────┴─────────────┴─────────────┴─────────────┘      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ WebSocket
                               ↓
              Chrome Extension (matches URL → domain)
```

## Architecture

### Core (`server/core/`)

- **protocol.ts** - WebSocket frame types (connect, message, command, etc.)
- **mesh-client.ts** - Connects to MCP Mesh, calls tools
- **domain.ts** - Domain interface and registry

### Domains (`server/domains/`)

Each domain implements:

```typescript
interface Domain {
  id: string;                      // "whatsapp"
  name: string;                    // "WhatsApp"
  urlPatterns: RegExp[];           // [/whatsapp\.com/]
  
  handleMessage(msg, ctx);         // Process incoming messages
  handleCommand?(cmd, args, ctx);  // Handle slash commands
  
  tools?: DomainTool[];            // Domain-specific mesh tools
  watchers?: DomainWatcher[];      // Content scripts
  systemPrompt?: string;           // AI system prompt
}
```

### Extension (`extension/`)

- **manifest.json** - Declares domains + content scripts
- **domains/whatsapp/content.js** - WhatsApp-specific injection
- **panel.css** - Shared styles

## Domains

| Domain | Status | URL Patterns | Description |
|--------|--------|--------------|-------------|
| WhatsApp | ✅ | `web.whatsapp.com` | Self-chat AI, message scraping |
| LinkedIn | 🔜 | `linkedin.com` | AI-powered messaging and networking |
| X (Twitter) | 🔜 | `x.com`, `twitter.com` | Tweet composition, DMs |
| Any Site | 🛠️ | `*` | RPA for any website—add a domain! |

## Protocol

### Client → Bridge

```typescript
// Connect with domain
{ type: "connect", client: "extension", domain: "whatsapp", url: "..." }

// Send message for AI processing
{ type: "message", id: "...", domain: "whatsapp", text: "...", chatId: "..." }

// Execute slash command
{ type: "command", id: "...", command: "/status", args: [] }

// Call mesh tool directly
{ type: "tool_call", id: "...", tool: "LLM_DO_GENERATE", arguments: {...} }

// Domain events (scraped data, etc.)
{ type: "event", event: "chats", domain: "whatsapp", data: [...] }
```

### Bridge → Client

```typescript
// Session established
{ type: "connected", sessionId: "...", domain: "whatsapp", mesh: {...} }

// AI response to send
{ type: "send", id: "...", chatId: "...", text: "🤖 ..." }

// Command response
{ type: "response", id: "...", text: "...", isComplete: true }

// Request data from extension
{ type: "event", event: "request_chats", data: {} }
```

## Adding a Domain

1. Create `server/domains/mydomain/index.ts`:

```typescript
import type { Domain } from "../../core/domain.ts";

export const myDomain: Domain = {
  id: "mydomain",
  name: "My Domain",
  urlPatterns: [/example\.com/],
  
  handleMessage: async (message, ctx) => {
    const response = await ctx.meshClient.generateWithLLM(
      "anthropic/claude-sonnet-4",
      [{ role: "user", content: message.text }],
    );
    ctx.send({ type: "send", id: message.id, chatId: message.chatId, text: response });
  },
};
```

2. Register in `server/main.ts`:

```typescript
import { myDomain } from "./domains/mydomain/index.ts";
registerDomain(myDomain);
```

3. Add content script in `extension/domains/mydomain/content.js`

4. Update `extension/manifest.json` to inject it

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check bridge + mesh status |
| `/tools` | List mesh tools |
| `/domains` | List registered domains |
| `/clear` | Clear conversation |

## Files

```
mesh-bridge/
├── server/
│   ├── core/
│   │   ├── domain.ts      # Domain interface
│   │   ├── mesh-client.ts # Mesh connection
│   │   └── protocol.ts    # WebSocket protocol
│   ├── domains/
│   │   └── whatsapp/
│   │       └── index.ts   # WhatsApp domain
│   ├── config.ts
│   └── main.ts            # Entry point
├── extension/
│   ├── domains/
│   │   └── whatsapp/
│   │       └── content.js # WhatsApp content script
│   ├── manifest.json
│   └── panel.css
├── app.json               # For mounting in mesh
└── README.md
```

## Future Domains

Next up:
- **LinkedIn** - AI-powered messaging, connection requests, networking
- **X (Twitter)** - Compose tweets, manage DMs, threads

RPA potential for any website:
- **Linear** - Create issues from chat
- **Notion** - Add notes, search docs
- **GitHub** - Review PRs, create issues
- **Gmail** - Draft emails, summarize inbox
- **Slack** - AI in channels, summarize threads
- **Any website** - Just add a domain!
